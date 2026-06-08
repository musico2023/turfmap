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

  // 4. Build a per-client queue of (location, keyword) tuples, THEN
  //    iterate round-robin — one tuple per client per round, looping
  //    until every queue is empty.
  //
  //    Why round-robin instead of client-by-client: scans are ~30-60s
  //    each and the function maxDuration is 300s. A single client with
  //    many tuples (e.g. D Spot Dessert Cafe: 5 locations × 12 keywords
  //    = 60 tuples) could consume the ENTIRE budget before any other
  //    client gets a chance. Result: D Spot scanned 60×, every other
  //    Pulse+ client scanned 0× (the bug Anthony flagged 2026-06-08).
  //
  //    Round-robin guarantees fairness: every client gets their first
  //    tuple scanned before any client gets their second. Combined
  //    with the hourly Monday schedule (0 * * * 1 in vercel.json),
  //    every client should complete their entire weekly set within
  //    a few hours of the first Monday tick.
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);
  const todayCutoff = todayStartUtc.toISOString();

  type ClientForScan = typeof activeClients[number];
  type LocationForScan = NonNullable<
    ReturnType<typeof locationsByClient.get>
  >[number];
  type KeywordForScan = NonNullable<typeof allKeywords>[number];
  type Tuple = {
    client: ClientForScan;
    location: LocationForScan;
    keyword: KeywordForScan;
  };
  const queuesByClient = new Map<string, Tuple[]>();
  const results: RunResult[] = [];
  let triggered = 0;
  let skipped = 0;
  let errors = 0;

  for (const client of activeClients) {
    const locations = locationsByClient.get(client.id) ?? [];
    const tier = resolveTier(client);
    const cap = maxKeywordsPerLocation(tier);
    const queue: Tuple[] = [];
    for (const location of locations) {
      const kws = keywordsByLocation.get(location.id) ?? [];
      const inCap = inCapKeywordIds(kws, cap);
      const weeklyKws = kws.filter((k) => k.scan_frequency === 'weekly');
      for (const kw of weeklyKws) {
        if (!inCap.has(kw.id)) {
          // Over-cap rows count as skipped but don't queue — they
          // don't burn cron budget and the result is recorded
          // immediately so an operator querying the cron response
          // can see why a specific tuple was excluded.
          results.push({
            clientId: client.id,
            locationId: location.id,
            keywordId: kw.id,
            skipped: 'over_cap',
          });
          skipped++;
          continue;
        }
        queue.push({ client, location, keyword: kw });
      }
    }
    if (queue.length > 0) queuesByClient.set(client.id, queue);
  }

  // Round-robin drain. Maintain a clientId order; pop one tuple from
  // each in turn; remove clients with empty queues; loop until none.
  const clientOrder = activeClients
    .map((c) => c.id)
    .filter((id) => queuesByClient.has(id));
  let round = 0;
  while (clientOrder.length > 0) {
    round++;
    const stillActive: string[] = [];
    for (const clientId of clientOrder) {
      const queue = queuesByClient.get(clientId);
      if (!queue || queue.length === 0) continue;
      const next = queue.shift()!;
      const r = await scanOneTuple(
        supabase,
        { id: next.client.id, business_name: next.client.business_name },
        next.location,
        next.keyword,
        todayCutoff
      );
      results.push(r);
      if (r.skipped) skipped++;
      else if (r.error) errors++;
      else triggered++;
      if (queue.length > 0) stillActive.push(clientId);
    }
    // Replace the client order with the still-non-empty subset.
    // Push the just-drained ones to the back of the queue so the
    // round-robin order rotates fairly across rounds.
    clientOrder.length = 0;
    clientOrder.push(...stillActive);
  }

  return NextResponse.json({
    triggered,
    skipped,
    errors,
    rounds: round,
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
