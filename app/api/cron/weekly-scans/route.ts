/**
 * Vercel Cron — weekly scheduled scans.
 *
 * Schedule (vercel.json): every Monday at 06:00 UTC.
 *
 * For each (active client, physical location, scan_frequency='weekly'
 * keyword) tuple, runs a Live Mode DataForSEO scan and persists the
 * result as scan_type='scheduled'. Idempotent within a UTC day — if a
 * scheduled scan for the same (location, keyword) pair was already run
 * today, it's skipped.
 *
 * Multi-location aware: a client with N locations and M keywords-per-
 * location yields up to N×M scans per cron run. Locations with missing
 * coords are skipped silently.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel Cron adds this
 * header automatically when CRON_SECRET is set in the project's env.
 *
 * Implementation note: scan execution is delegated to
 * lib/scans/runScan.runScanForLocation so this route shares the exact
 * same code path as the manual /api/scans/trigger endpoint. No metric
 * drift, no missing location_id, NAP audit auto-fires post-scan.
 *
 * Returns: { triggered, skipped, errors, results: [{...}] }
 */

import { NextResponse } from 'next/server';
import dns from 'node:dns';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase } from '@/lib/supabase/server';
import { runScanForLocation } from '@/lib/scans/runScan';
import {
  maxKeywordsPerLocation,
  resolveTier,
} from '@/lib/subscription/tier';
import { inCapKeywordIds } from '@/lib/subscription/keywordCap';
import type {
  ClientLocationRow,
  ClientRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

dns.setDefaultResultOrder('ipv4first');

export const runtime = 'nodejs';
// Bumped from 60s → 300s. The previous 60s ceiling could only handle
// 1-2 scans before timing out; with multi-location each scan run can
// produce many more (N locations × M keywords). 300s lets us complete
// roughly 8-10 scheduled scans per cron tick — beyond that, we'd need
// to chunk across multiple cron invocations or move to Standard Queue.
export const maxDuration = 300;

type RunResult = {
  clientId: string;
  locationId: string;
  keywordId: string;
  scanId?: string;
  error?: string;
  skipped?: 'already_ran_today' | 'location_missing_coords' | 'over_cap';
};

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  return handle(req);
}
// Vercel Cron uses GET; allow either to make local testing easier.
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();

  // 1. Active clients only. tier + billing_mode pulled so the cap
  //    helper can resolve the effective tier per client. Outreach-
  //    enrichment rows are excluded — those back cold-lead share
  //    links and aren't billed, so we don't keep burning DFS credits
  //    re-scanning them.
  const { data: clients, error: cErr } = await supabase
    .from('clients')
    .select('id, business_name, status, tier, billing_mode')
    .eq('status', 'active')
    .eq('is_outreach_lead', false)
    .returns<
      Pick<
        ClientRow,
        'id' | 'business_name' | 'status' | 'tier' | 'billing_mode'
      >[]
    >();
  if (cErr) {
    return NextResponse.json(
      { error: `client query failed: ${cErr.message}` },
      { status: 500 }
    );
  }
  const activeClients = clients ?? [];
  if (activeClients.length === 0) {
    return NextResponse.json({
      triggered: 0,
      skipped: 0,
      errors: 0,
      results: [],
      runAt: new Date().toISOString(),
      note: 'no active clients',
    });
  }

  // 2. All locations for those clients.
  const clientIds = activeClients.map((c) => c.id);
  const { data: allLocations } = await supabase
    .from('client_locations')
    .select(
      'id, client_id, latitude, longitude, service_radius_miles, label'
    )
    .in('client_id', clientIds)
    .returns<
      Pick<
        ClientLocationRow,
        | 'id'
        | 'client_id'
        | 'latitude'
        | 'longitude'
        | 'service_radius_miles'
        | 'label'
      >[]
    >();
  const locationsByClient = new Map<
    string,
    typeof allLocations
  >();
  for (const loc of allLocations ?? []) {
    const list = locationsByClient.get(loc.client_id) ?? [];
    list.push(loc);
    locationsByClient.set(loc.client_id, list);
  }

  // 3. All keywords for those clients. We pull ALL frequencies (not
  //    just 'weekly') so the in-cap ordering — first `cap` keywords by
  //    (is_primary DESC, created_at ASC) per location — is computed
  //    over the complete set. Otherwise a Pulse client with a primary
  //    monthly + 3 weekly keywords would compute a misleading cutoff.
  const { data: allKeywords } = await supabase
    .from('tracked_keywords')
    .select(
      'id, client_id, location_id, keyword, is_primary, created_at, scan_frequency'
    )
    .in('client_id', clientIds)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .returns<
      Pick<
        TrackedKeywordRow,
        | 'id'
        | 'client_id'
        | 'location_id'
        | 'keyword'
        | 'is_primary'
        | 'created_at'
        | 'scan_frequency'
      >[]
    >();

  // Index ALL keywords by location_id — preserves the (is_primary,
  // created_at) ordering inside each bucket so the cap-cutoff is
  // deterministic. Legacy rows without location_id are skipped (cron
  // can't scan a keyword with no location anyway).
  type CronKeyword = Pick<
    TrackedKeywordRow,
    | 'id'
    | 'client_id'
    | 'location_id'
    | 'keyword'
    | 'is_primary'
    | 'created_at'
    | 'scan_frequency'
  >;
  const keywordsByLocation = new Map<string, CronKeyword[]>();
  for (const kw of allKeywords ?? []) {
    if (kw.location_id) {
      const list = keywordsByLocation.get(kw.location_id) ?? [];
      list.push(kw);
      keywordsByLocation.set(kw.location_id, list);
    }
  }

  // 4. Iterate (client, location, keyword) tuples sequentially. Each
  //    scan is ~30-60s; sequential keeps the function within
  //    maxDuration without parallelism complexity.
  const results: RunResult[] = [];
  let triggered = 0;
  let skipped = 0;
  let errors = 0;

  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);
  const todayCutoff = todayStartUtc.toISOString();

  for (const client of activeClients) {
    const locations = locationsByClient.get(client.id) ?? [];
    // Tier-driven cap: precompute the in-cap keyword id set per
    // location for this client. Over-cap rows fire neither scheduled
    // nor on-demand scans — see lib/subscription/keywordCap.
    const tier = resolveTier(client);
    const cap = maxKeywordsPerLocation(tier);
    for (const location of locations) {
      const kws = keywordsByLocation.get(location.id) ?? [];
      const inCap = inCapKeywordIds(kws, cap);
      // Filter to weekly here (we pulled all frequencies above for the
      // ordering — see step 3). Other cadences are handled by their
      // own crons.
      const weeklyKws = kws.filter((k) => k.scan_frequency === 'weekly');
      for (const kw of weeklyKws) {
        if (!inCap.has(kw.id)) {
          results.push({
            clientId: client.id,
            locationId: location.id,
            keywordId: kw.id,
            skipped: 'over_cap',
          });
          skipped++;
          continue;
        }
        const r = await scanOneTuple(
          supabase,
          { id: client.id, business_name: client.business_name },
          location,
          kw,
          todayCutoff
        );
        results.push(r);
        if (r.skipped) skipped++;
        else if (r.error) errors++;
        else triggered++;
      }
    }
  }

  return NextResponse.json({
    triggered,
    skipped,
    errors,
    results,
    runAt: new Date().toISOString(),
  });
}

async function scanOneTuple(
  supabase: SupabaseLike,
  client: Pick<ClientRow, 'id' | 'business_name'>,
  location: Pick<
    ClientLocationRow,
    | 'id'
    | 'client_id'
    | 'latitude'
    | 'longitude'
    | 'service_radius_miles'
    | 'label'
  >,
  keyword: Pick<TrackedKeywordRow, 'id' | 'keyword'>,
  todayCutoff: string
): Promise<RunResult> {
  const base: RunResult = {
    clientId: client.id,
    locationId: location.id,
    keywordId: keyword.id,
  };

  // Skip locations missing coords — they can't generate a grid.
  if (location.latitude == null || location.longitude == null) {
    return { ...base, skipped: 'location_missing_coords' };
  }

  // Idempotency: skip if a scheduled scan for THIS (location, keyword)
  // already ran today. The previous version was scoped to (client,
  // keyword) which was wrong for multi-location — Don Mills's scan
  // would block Wychwood's scan if they shared a keyword id (they
  // don't, post-0006, but the tighter constraint here is cleaner).
  const { data: existing } = await supabase
    .from('scans')
    .select('id')
    .eq('client_id', client.id)
    .eq('location_id', location.id)
    .eq('keyword_id', keyword.id)
    .eq('scan_type', 'scheduled')
    .gte('created_at', todayCutoff)
    .limit(1)
    .maybeSingle<Pick<ScanRow, 'id'>>();
  if (existing) {
    return { ...base, scanId: existing.id, skipped: 'already_ran_today' };
  }

  // Delegate to the shared executor — same code path as the manual
  // trigger button. NAP audit auto-fires inside.
  const result = await runScanForLocation(supabase, {
    client,
    location,
    keyword,
    scanType: 'scheduled',
    triggeredBy: null, // cron-driven; no operator user id
  });

  if (!result.ok) {
    return { ...base, scanId: result.scanId, error: result.error };
  }
  return { ...base, scanId: result.scanId };
}
