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
  runDfsCitationAudit,
  type CitationBusinessProfile,
  type SiblingLocation as DfsSiblingLocation,
} from '@/lib/citations/dfsChecker';
import {
  directoriesForProfile as dfsDirectoriesForProfile,
  inferDfsProfile,
} from '@/lib/citations/directories';
import { primaryTypeToIndustry } from '@/lib/google/primaryTypeToIndustry';
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

/** Trigger-source vocabulary mirrored from migration 0040's CHECK
 *  constraint on nap_audits.trigger_source. Keep this enum in sync
 *  with the migration's allowed-values list — adding a new value
 *  here without updating the constraint will cause inserts to
 *  reject. See NapAuditRow.trigger_source for full semantics. */
export type NapAuditTriggerSource =
  | 'scan'
  | 'audit-init'
  | 'ai-coach'
  | 'manual'
  | 'cron';

/**
 * Which backend to use for NAP audits. Selected via env so we can
 * switch back to BrightLocal Data API when commercial access is in
 * place (10k req/mo @ $500/mo — see notes in lib/brightlocal/client.ts).
 *
 *   NAP_AUDIT_PROVIDER=brightlocal — use BL Data API (requires
 *                                     250-req trial OR commercial key)
 *   NAP_AUDIT_PROVIDER=dfs        — use DataForSEO SERP scrape
 *                                     (~$0.09/audit; default)
 *   (anything else / unset)        — defaults to dfs
 */
type AuditProvider = 'brightlocal' | 'dfs';
function pickProvider(): AuditProvider {
  const v = (process.env.NAP_AUDIT_PROVIDER ?? '').toLowerCase();
  return v === 'brightlocal' ? 'brightlocal' : 'dfs';
}

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
  locationId: string | null = null,
  triggerSource: NapAuditTriggerSource | null = null,
  /** When `force` is true, bypass the 30-day recent-audit window and
   *  run a fresh audit unconditionally. Set by deliberate operator
   *  regenerate flows (force_regenerate) where stale findings are the
   *  exact thing being refreshed. Costs one DFS audit (~$0.09). */
  opts: { force?: boolean } = {}
): Promise<{ ran: boolean; auditId?: string; reason?: string }> {
  // 1. Pull client metadata. The historical billing_mode='one_time' tier
  // gate is GONE — DFS-based audits (default provider) cost ~$0.09 per
  // audit, sustainable across every buyer tier including $0 free scans.
  // Reverts commit 850a51b's tier gate at the autoAudit level (the gate
  // was specifically a BL trial preservation measure that no longer
  // applies under DFS).
  const { data: client } = await supabase
    .from('clients')
    .select('business_name, industry, billing_mode')
    .eq('id', clientId)
    .maybeSingle<
      Pick<ClientRow, 'business_name' | 'industry' | 'billing_mode'>
    >();
  if (!client) {
    return { ran: false, reason: 'client not found' };
  }

  // 2. Resolve the target location.
  const location = await resolveLocation(supabase, clientId, locationId);
  if (!location) {
    return { ran: false, reason: 'no location resolved for this client' };
  }

  // 3. Recent audit on this exact location? Skipped when force=true
  //    (deliberate operator regenerate — the whole point is a fresh run).
  if (!opts.force) {
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
  }

  // 4. NAP fields complete on the location?
  const business = locationToBusinessProfile(client.business_name, location);
  if (!business) {
    return {
      ran: false,
      reason: 'location missing structured NAP fields',
    };
  }

  // 4b. Resolve the directory-profile industry. Prefer the operator-set
  //     client.industry; when it's blank (common — clients onboarded
  //     without picking one, e.g. CertaPro), derive the vertical from the
  //     GBP primary type so the audit still selects the right directory
  //     profile. Without this, a painter with no industry fell through to
  //     the generic 'universal' profile, so the home-services directories
  //     (HomeStars / Angi / Houzz) were never checked and the AI Coach
  //     only had generic dirs (Yelp/Facebook/BBB) to recommend.
  let effectiveIndustry = client.industry;
  if (!effectiveIndustry || effectiveIndustry.trim().length === 0) {
    const { data: sig } = await supabase
      .from('gbp_signals')
      .select('primary_type')
      .eq('client_location_id', location.id)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ primary_type: string | null }>();
    effectiveIndustry = primaryTypeToIndustry(sig?.primary_type ?? null);
  }

  // 5. Provider dispatch. Default = DFS (cheap, covers every tier).
  //    Opt in to BrightLocal via env when commercial Data API access is
  //    in place.
  const provider = pickProvider();
  if (provider === 'dfs') {
    // Pass the resolved location's lat/lng through to the DFS path —
    // the new local_pack GBP probe (added in v1.2) centers on
    // (lat,lng,1km) when available, virtually guaranteeing the
    // buyer's own GBP ranks at the top of the local pack if one
    // exists. Without coords the probe falls back to location_name
    // string, which is fine but less precise.
    return runDfsAudit(
      supabase,
      clientId,
      location.id,
      triggeredBy,
      business,
      effectiveIndustry,
      location.latitude,
      location.longitude,
      triggerSource
    );
  }
  return runBrightlocalAudit(
    supabase,
    clientId,
    location.id,
    triggeredBy,
    business,
    effectiveIndustry,
    triggerSource
  );
}

/** DFS-backed audit path. Runs synchronously (~5-9s for ~9 directories),
 *  inserts a single nap_audits row stamped as 'complete' on success or
 *  'failed' on exception. Never throws to the caller.
 *
 *  Sibling-aware: pulls every other location of the same client and
 *  passes them to the checker so listings whose NAP matches a sibling
 *  get classified as `sibling_match` instead of false-flagged. */
async function runDfsAudit(
  supabase: SupabaseLike,
  clientId: string,
  locationId: string,
  triggeredBy: string | null,
  business: BusinessProfile,
  industry: string | null,
  latitude: number | null,
  longitude: number | null,
  triggerSource: NapAuditTriggerSource | null
): Promise<{ ran: boolean; auditId?: string; reason?: string }> {
  // Insert pending row first so the row id is stable even if the audit
  // itself throws.
  const { data: row, error: insErr } = await supabase
    .from('nap_audits')
    .insert({
      client_id: clientId,
      location_id: locationId,
      triggered_by: triggeredBy,
      status: 'pending',
      provider: 'dfs',
      trigger_source: triggerSource,
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !row) {
    return {
      ran: false,
      reason: `audit row insert failed: ${insErr?.message ?? 'no row'}`,
    };
  }

  try {
    const profile = inferDfsProfile(industry);
    const directories = dfsDirectoriesForProfile(profile, business.country);

    // Sibling locations: every other location of the same brand, in the
    // SiblingLocation shape DFS expects. BL's BusinessProfile has
    // country?: string (optional); DFS's CitationBusinessProfile
    // requires it — default to 'USA' for safety since most clients are
    // US-based, but the helper that built siblingBp would have set it
    // explicitly when the location has a country_code populated.
    const allLocations = await listLocations(supabase, clientId);
    const siblings: DfsSiblingLocation[] = [];
    for (const l of allLocations) {
      if (l.id === locationId) continue;
      const siblingBp = locationToBusinessProfile(business.name, l);
      if (!siblingBp) continue;
      siblings.push({
        ...siblingBp,
        country: siblingBp.country ?? 'USA',
        label: locationDisplayLabel(l),
      });
    }

    const canonical: CitationBusinessProfile = {
      name: business.name,
      street_address: business.street_address,
      city: business.city,
      region: business.region,
      postcode: business.postcode,
      country: business.country ?? 'USA',
      telephone: business.telephone,
      latitude,
      longitude,
    };

    const result = await runDfsCitationAudit(canonical, directories, siblings);

    const findings = result.findings;
    const totalCitations = findings.citations.length;
    const inconsistenciesCount = findings.inconsistencies.length;
    const missingHigh = findings.missing.filter((m) => m.priority === 'high').length;
    const completedAt = new Date().toISOString();

    await supabase
      .from('nap_audits')
      .update({
        status: 'complete',
        findings,
        raw_response: result.per_directory_summary,
        total_citations: totalCitations,
        inconsistencies_count: inconsistenciesCount,
        missing_high_priority_count: missingHigh,
        completed_at: completedAt,
      })
      .eq('id', row.id);

    return {
      ran: true,
      auditId: row.id,
      reason: `dfs provider, profile=${profile}, dirs=${directories.length}, cost=$${result.total_cost_dollars.toFixed(4)}`,
    };
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
      reason: `DFS audit failed: ${msg}`,
    };
  }
}

/** BrightLocal-backed audit path. Existing behavior preserved verbatim;
 *  only invoked when NAP_AUDIT_PROVIDER=brightlocal is set (default is
 *  DFS). Async — initiate fan-out is sync (~1-2s), then `pollAuditResults`
 *  finalizes asynchronously via maybeFinalizeNapAudit. */
async function runBrightlocalAudit(
  supabase: SupabaseLike,
  clientId: string,
  locationId: string,
  triggeredBy: string | null,
  business: BusinessProfile,
  industry: string | null,
  triggerSource: NapAuditTriggerSource | null
): Promise<{ ran: boolean; auditId?: string; reason?: string }> {
  const directories = getDirectoriesForIndustry(industry);
  const profile = inferProfileForIndustry(industry);

  const { data: row, error: insErr } = await supabase
    .from('nap_audits')
    .insert({
      client_id: clientId,
      location_id: locationId,
      triggered_by: triggeredBy,
      status: 'pending',
      provider: 'brightlocal',
      trigger_source: triggerSource,
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !row) {
    return {
      ran: false,
      reason: `audit row insert failed: ${insErr?.message ?? 'no row'}`,
    };
  }

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
    return { ran: true, auditId: row.id, reason: `brightlocal provider, profile: ${profile}` };
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
