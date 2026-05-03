/**
 * Auto-trigger + auto-finalize helpers for NAP audits.
 *
 * The NAP audit feature has no user-facing surface — audits are kicked off
 * automatically when the operator runs a scan, and finalized lazily when
 * the AI Coach is invoked (or by a future cron). The helpers here keep
 * that orchestration logic out of route handlers so both the scan-trigger
 * and ai-insights routes can share the same plumbing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  initiateCitationAudit,
  pollAuditResults,
  summarizeFindings,
  type BusinessProfile,
} from '@/lib/brightlocal/client';
import type {
  ClientRow,
  NapAuditFindings,
  NapAuditRequest,
  NapAuditRow,
} from '@/lib/supabase/types';

/** Match the bare-generics SupabaseClient that `getServerSupabase()`
 *  returns — DB-level type narrowing isn't needed here, but keeping a
 *  named alias makes the helper signatures readable. */
type SupabaseLike = SupabaseClient;

/** Time window before we consider an existing audit "stale" enough to
 *  warrant a fresh run. Citation rot is slow — 30 days is plenty. */
const AUDIT_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Convert a clients row into the BusinessProfile shape BrightLocal needs.
 *  Returns null if any required structured field is missing — the caller
 *  treats null as "skip the audit". */
export function clientToBusinessProfile(
  client: Pick<
    ClientRow,
    | 'business_name'
    | 'phone'
    | 'street_address'
    | 'city'
    | 'region'
    | 'postcode'
    | 'country_code'
  >
): BusinessProfile | null {
  if (
    !client.business_name ||
    !client.phone ||
    !client.street_address ||
    !client.city ||
    !client.region ||
    !client.postcode
  ) {
    return null;
  }
  return {
    name: client.business_name,
    telephone: client.phone,
    street_address: client.street_address,
    city: client.city,
    region: client.region,
    postcode: client.postcode,
    country: client.country_code ?? 'USA',
  };
}

/**
 * Kick off a NAP audit for a client if there isn't a recent (< 30 days)
 * one already in flight or complete. Awaits the BrightLocal `find` fan-out
 * (~1-2s for ≤ 15 directories) but never throws — failures are persisted
 * to the audit row's error_message so the scan response is unaffected.
 *
 * Idempotent: safe to call from every scan trigger; only runs an audit
 * once per refresh window.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function maybeRunNapAudit(
  supabase: SupabaseLike,
  clientId: string,
  triggeredBy: string | null
): Promise<{ ran: boolean; auditId?: string; reason?: string }> {
  // 1. Already a recent audit?
  const since = new Date(
    Date.now() - AUDIT_REFRESH_WINDOW_MS
  ).toISOString();
  const { data: recent } = await supabase
    .from('nap_audits')
    .select('id, status, created_at')
    .eq('client_id', clientId)
    .in('status', ['pending', 'running', 'complete'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<NapAuditRow, 'id' | 'status' | 'created_at'>>();
  if (recent) {
    return { ran: false, reason: `recent audit already ${recent.status}` };
  }

  // 2. Pull client + verify NAP fields are populated.
  const { data: client } = await supabase
    .from('clients')
    .select(
      'business_name, phone, street_address, city, region, postcode, country_code'
    )
    .eq('id', clientId)
    .maybeSingle<
      Pick<
        ClientRow,
        | 'business_name'
        | 'phone'
        | 'street_address'
        | 'city'
        | 'region'
        | 'postcode'
        | 'country_code'
      >
    >();
  if (!client) {
    return { ran: false, reason: 'client not found' };
  }
  const business = clientToBusinessProfile(client);
  if (!business) {
    return { ran: false, reason: 'client missing structured NAP fields' };
  }

  // 3. Insert a pending audit row first so we have a stable id even if
  //    BL's initiate fan-out throws.
  const { data: row, error: insErr } = await supabase
    .from('nap_audits')
    .insert({
      client_id: clientId,
      triggered_by: triggeredBy,
      status: 'pending',
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !row) {
    return {
      ran: false,
      reason: `audit row insert failed: ${insErr?.message ?? 'no row'}`,
    };
  }

  // 4. Fan out. Catch all errors so the caller (scan trigger) never sees them.
  try {
    const result = await initiateCitationAudit(business);
    await supabase
      .from('nap_audits')
      .update({
        status: 'running',
        brightlocal_requests: result.requests,
        brightlocal_rejected: result.rejected,
      })
      .eq('id', row.id);
    return { ran: true, auditId: row.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from('nap_audits')
      .update({
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    return { ran: false, auditId: row.id, reason: `BL initiate failed: ${msg}` };
  }
}

/**
 * Look for a `running` audit on this client. If found, poll BL once.
 * If all directories are ready, finalize: persist findings + flip status
 * to `complete`. Returns the latest complete findings (whether finalized
 * just now or already complete from a prior run), or null if there's no
 * usable audit data yet.
 *
 * Used by the AI Coach route so insight generation lazily advances any
 * audits that finished while the operator was waiting.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function maybeFinalizeNapAudit(
  supabase: SupabaseLike,
  clientId: string
): Promise<{ findings: NapAuditFindings; completedAt: string | null } | null> {
  // 1. Most recent audit for this client (any status).
  const { data: latest } = await supabase
    .from('nap_audits')
    .select(
      'id, status, completed_at, findings, brightlocal_requests'
    )
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<
        NapAuditRow,
        | 'id'
        | 'status'
        | 'completed_at'
        | 'findings'
        | 'brightlocal_requests'
      >
    >();
  if (!latest) return null;

  // 2. Already complete — return findings as-is.
  if (latest.status === 'complete' && latest.findings) {
    return {
      findings: latest.findings as NapAuditFindings,
      completedAt: latest.completed_at,
    };
  }
  if (latest.status !== 'running' && latest.status !== 'pending') {
    return null;
  }
  const requests = (latest.brightlocal_requests ?? []) as NapAuditRequest[];
  if (requests.length === 0) return null;

  // 3. Poll BL once. Network errors are absorbed — we just don't ground
  //    THIS coach run on NAP data.
  let summary;
  try {
    summary = await pollAuditResults(requests);
  } catch {
    return null;
  }
  if (!summary.allReady) return null;

  // 4. All ready — finalize.
  const { data: client } = await supabase
    .from('clients')
    .select(
      'business_name, phone, street_address, city, region, postcode, country_code'
    )
    .eq('id', clientId)
    .maybeSingle<
      Pick<
        ClientRow,
        | 'business_name'
        | 'phone'
        | 'street_address'
        | 'city'
        | 'region'
        | 'postcode'
        | 'country_code'
      >
    >();
  if (!client) return null;
  const business = clientToBusinessProfile(client);
  if (!business) return null;

  const findings = summarizeFindings(summary.perDirectory, business);
  const totalCitations = findings.citations.length;
  const inconsistenciesCount = findings.inconsistencies.length;
  const missingHigh = findings.missing.filter(
    (m) => m.priority === 'high'
  ).length;
  const completedAt = new Date().toISOString();

  await supabase
    .from('nap_audits')
    .update({
      status: 'complete',
      findings,
      raw_response: summary.perDirectory,
      total_citations: totalCitations,
      inconsistencies_count: inconsistenciesCount,
      missing_high_priority_count: missingHigh,
      completed_at: completedAt,
    })
    .eq('id', latest.id);

  return { findings, completedAt };
}
