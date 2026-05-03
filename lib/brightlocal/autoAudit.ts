/**
 * Auto-trigger + auto-finalize helpers for NAP audits.
 *
 * The NAP audit feature has no user-facing surface — audits are kicked off
 * automatically when the operator runs a scan, and finalized lazily when
 * the AI Coach is invoked (or by a future cron). The helpers here keep
 * that orchestration logic out of route handlers so both the scan-trigger
 * and ai-insights routes can share the same plumbing.
 *
 * As of migration 0006 (multi-location support), audits are scoped to
 * one location, not one client. A multi-location client (e.g. Kidcrew
 * with Wychwood + Don Mills) gets a separate audit per location since
 * each storefront has its own NAP and citation footprint.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  initiateCitationAudit,
  pollAuditResults,
  summarizeFindings,
  type BusinessProfile,
  type SiblingLocation,
} from '@/lib/brightlocal/client';
import {
  getDirectoriesForIndustry,
  inferProfileForIndustry,
} from '@/lib/brightlocal/directories';
import {
  listLocations,
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import type {
  ClientLocationRow,
  ClientRow,
  NapAuditFindings,
  NapAuditRequest,
  NapAuditRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

/** Time window before we consider an existing audit "stale" enough to
 *  warrant a fresh run. Citation rot is slow — 30 days is plenty. */
const AUDIT_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Compose a BrightLocal BusinessProfile from a client (for the brand
 *  name + industry context) and one of its locations (for NAP fields).
 *  Returns null when any required field is missing — caller skips audit. */
export function locationToBusinessProfile(
  businessName: string,
  location: Pick<
    ClientLocationRow,
    | 'phone'
    | 'street_address'
    | 'city'
    | 'region'
    | 'postcode'
    | 'country_code'
  >
): BusinessProfile | null {
  if (
    !businessName ||
    !location.phone ||
    !location.street_address ||
    !location.city ||
    !location.region ||
    !location.postcode
  ) {
    return null;
  }
  return {
    name: businessName,
    telephone: location.phone,
    street_address: location.street_address,
    city: location.city,
    region: location.region,
    postcode: location.postcode,
    country: location.country_code ?? 'USA',
  };
}

/**
 * Kick off a NAP audit for one specific location of a client if there
 * isn't a recent (< 30 days) one already in flight or complete for that
 * location. Awaits the BrightLocal `find` fan-out (~1-2s for ≤ 15
 * directories) but never throws — failures are persisted to the audit
 * row's error_message so the calling route is unaffected.
 *
 * If `locationId` is null/undefined, defaults to the client's primary
 * location — preserves single-location behavior for clients without
 * multi-location setups.
 *
 * Idempotent: safe to call from every scan trigger; only runs an audit
 * once per refresh window per location.
 */
export async function maybeRunNapAudit(
  supabase: SupabaseLike,
  clientId: string,
  triggeredBy: string | null,
  locationId: string | null = null
): Promise<{ ran: boolean; auditId?: string; reason?: string }> {
  // 1. Resolve the target location (the explicit one, or the client's
  //    primary). No location → can't audit.
  const location = await resolveLocation(supabase, clientId, locationId);
  if (!location) {
    return { ran: false, reason: 'no location resolved for this client' };
  }

  // 2. Already a recent audit for this exact location?
  const since = new Date(
    Date.now() - AUDIT_REFRESH_WINDOW_MS
  ).toISOString();
  const { data: recent } = await supabase
    .from('nap_audits')
    .select('id, status, created_at')
    .eq('client_id', clientId)
    .eq('location_id', location.id)
    .in('status', ['pending', 'running', 'complete'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<NapAuditRow, 'id' | 'status' | 'created_at'>>();
  if (recent) {
    return { ran: false, reason: `recent audit already ${recent.status}` };
  }

  // 3. Pull client (for business_name + industry).
  const { data: client } = await supabase
    .from('clients')
    .select('business_name, industry')
    .eq('id', clientId)
    .maybeSingle<Pick<ClientRow, 'business_name' | 'industry'>>();
  if (!client) {
    return { ran: false, reason: 'client not found' };
  }

  // 4. NAP fields complete on the location?
  const business = locationToBusinessProfile(client.business_name, location);
  if (!business) {
    return {
      ran: false,
      reason: 'location missing structured NAP fields',
    };
  }

  // 5. Industry-aware directory selection (a pediatric clinic shouldn't
  //    be audited against Angi/Houzz/etc).
  const directories = getDirectoriesForIndustry(client.industry);
  const profile = inferProfileForIndustry(client.industry);

  // 6. Insert a pending audit row first so we have a stable id even if
  //    BL's initiate fan-out throws.
  const { data: row, error: insErr } = await supabase
    .from('nap_audits')
    .insert({
      client_id: clientId,
      location_id: location.id,
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

  // 7. Fan out across the industry-tuned directory set. Catch all errors
  //    so the caller (scan trigger or AI Coach) never sees them.
  try {
    const result = await initiateCitationAudit(business, directories);
    await supabase
      .from('nap_audits')
      .update({
        status: 'running',
        brightlocal_requests: result.requests,
        brightlocal_rejected: result.rejected,
      })
      .eq('id', row.id);
    return { ran: true, auditId: row.id, reason: `profile: ${profile}` };
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
    return {
      ran: false,
      auditId: row.id,
      reason: `BL initiate failed: ${msg}`,
    };
  }
}

/**
 * Default polling cadence inside maybeFinalizeNapAudit when waitForReadyMs > 0.
 * 12s strikes a balance between responsiveness and BL rate limits (300 GETs/min
 * across all clients). At 12s × 15 directories per audit, one in-flight audit
 * burns ~75 GETs/min — well under the cap.
 */
const POLL_INTERVAL_MS = 12_000;

/**
 * Look for a recent audit on this LOCATION (not this client). Behavior
 * depends on `waitForReadyMs`:
 *
 *   waitForReadyMs = 0 (default) — one-shot poll, returns null if not ready.
 *   waitForReadyMs > 0           — loops every POLL_INTERVAL_MS until either
 *                                  the audit is ready (returns findings) or
 *                                  the budget expires (returns null).
 *
 * Always returns null gracefully when there's no usable audit; never throws.
 *
 * If `locationId` is null, defaults to the client's primary location.
 */
export async function maybeFinalizeNapAudit(
  supabase: SupabaseLike,
  clientId: string,
  options: { waitForReadyMs?: number; locationId?: string | null } = {}
): Promise<{ findings: NapAuditFindings; completedAt: string | null } | null> {
  const budgetMs = Math.max(0, options.waitForReadyMs ?? 0);
  const deadline = Date.now() + budgetMs;

  // Resolve location once up front. If there's no location at all, we
  // can't even look for an audit.
  const location = await resolveLocation(
    supabase,
    clientId,
    options.locationId ?? null
  );
  if (!location) return null;

  while (true) {
    // 1. Most recent audit for this exact location (any status).
    const { data: latest } = await supabase
      .from('nap_audits')
      .select(
        'id, status, completed_at, findings, brightlocal_requests'
      )
      .eq('client_id', clientId)
      .eq('location_id', location.id)
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

    // 2. Already complete (from a prior run or just-finalized) — return.
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

    // 3. Poll BL. Network errors absorbed; on persistent failure we just
    //    let the loop exit via deadline check.
    let summary = null;
    try {
      summary = await pollAuditResults(requests);
    } catch {
      // swallow — we'll retry on the next loop iteration if budget allows
    }

    // 4. All ready — finalize.
    if (summary && summary.allReady) {
      const { data: client } = await supabase
        .from('clients')
        .select('business_name, industry')
        .eq('id', clientId)
        .maybeSingle<Pick<ClientRow, 'business_name' | 'industry'>>();
      if (!client) return null;
      const business = locationToBusinessProfile(
        client.business_name,
        location
      );
      if (!business) return null;

      // Sibling locations: every other location of the same brand.
      // Citations whose NAP matches a sibling won't be flagged as
      // inconsistencies — they're correctly the sibling's listing,
      // just not this location's.
      const allLocations = await listLocations(supabase, clientId);
      const siblings: SiblingLocation[] = [];
      for (const l of allLocations) {
        if (l.id === location.id) continue;
        const siblingBp = locationToBusinessProfile(client.business_name, l);
        if (!siblingBp) continue;
        siblings.push({ ...siblingBp, label: locationDisplayLabel(l) });
      }

      const findings = summarizeFindings(
        summary.perDirectory,
        business,
        siblings,
        { industry: client.industry }
      );
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

    // 5. Not ready — bail if no budget left, otherwise sleep + loop.
    const remaining = deadline - Date.now();
    if (remaining < POLL_INTERVAL_MS) {
      // Coach proceeds without grounding rather than blocking forever.
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
