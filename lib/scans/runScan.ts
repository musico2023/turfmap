/**
 * Shared scan execution.
 *
 * Used by:
 *   - /api/scans/trigger (operator-clicked Re-scan turf button)
 *   - /api/cron/weekly-scans (Vercel Cron weekly run for scheduled keywords)
 *
 * Both paths converge here so the score family (TurfReach / TurfRank /
 * TurfScore / Momentum), location_id stamping, and NAP-audit auto-trigger
 * stay consistent. Anthony hit drift between trigger + cron once already
 * (cron was still using the deprecated turfScore/top3Rate metrics) — this
 * extraction prevents that recurring.
 *
 * Caller responsibilities:
 *   - Auth (cron checks CRON_SECRET; trigger checks agency session)
 *   - Resolving client + location + keyword from URL params or body
 *   - Idempotency / rate-limit checks where applicable (cron skips
 *     same-day repeats; trigger doesn't currently rate-limit)
 *
 * This function:
 *   - Inserts a scan row in 'running' state
 *   - Generates the 9×9 grid from the location's coords
 *   - Runs the DataForSEO Live Mode scan
 *   - Persists scan_points
 *   - Computes the score family (with same-day-rescan-aware momentum)
 *   - Updates the scan row to 'complete'
 *   - Auto-fires the NAP audit for this location (best-effort)
 *
 * Returns a structured result. On hard failure the scan row is marked
 * 'failed' and the function returns { ok: false, error, scanId? }.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runLiveLocalPackScan } from '@/lib/dataforseo/client';
import { generateGridCoordinates } from '@/lib/dataforseo/grid';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { momentum as computeMomentum } from '@/lib/metrics/momentum';
import { maybeRunNapAudit } from '@/lib/brightlocal/autoAudit';
import type {
  ClientLocationRow,
  ClientRow,
  ScanType,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type RunScanInput = {
  client: Pick<ClientRow, 'id' | 'business_name'>;
  location: Pick<
    ClientLocationRow,
    'id' | 'latitude' | 'longitude' | 'service_radius_miles'
  >;
  keyword: Pick<TrackedKeywordRow, 'id' | 'keyword'>;
  scanType: ScanType;
  /** User uuid that triggered this scan, or null for cron-driven runs.
   *  Recorded on the audit row's triggered_by column when the post-scan
   *  audit fires. */
  triggeredBy: string | null;
};

export type RunScanSuccess = {
  ok: true;
  scanId: string;
  totalPoints: number;
  failedPoints: number;
  dfsCostCents: number;
  found: number;
  turfScore: number;
  turfReach: number;
  /** Null when zero cells were in-pack (no rank to average). */
  turfRank: number | null;
  momentum: number | null;
};

export type RunScanFailure = {
  ok: false;
  error: string;
  scanId?: string;
};

export type RunScanResult = RunScanSuccess | RunScanFailure;

/**
 * Window before a previous-scan reading counts as "real" momentum
 * baseline. Same-day rescans within 12 hours all compare to a scan
 * from before the window — kills false +/- swings from operator
 * iterating on GBP edits or re-running after a failed scan.
 */
const MOMENTUM_BASELINE_WINDOW_HOURS = 12;

export async function runScanForLocation(
  supabase: SupabaseLike,
  input: RunScanInput
): Promise<RunScanResult> {
  const { client, location, keyword, scanType, triggeredBy } = input;

  if (location.latitude == null || location.longitude == null) {
    return {
      ok: false,
      error:
        "location is missing coordinates — fill in the address (auto-geocodes) or set lat/lng manually in the location's settings",
    };
  }

  // 1. Insert running scan row, pinned to this client + location + keyword.
  const { data: scanRow, error: insErr } = await supabase
    .from('scans')
    .insert({
      client_id: client.id,
      location_id: location.id,
      keyword_id: keyword.id,
      scan_type: scanType,
      grid_size: 9,
      status: 'running',
      total_points: 81,
    })
    .select('id')
    .single<{ id: string }>();
  if (insErr || !scanRow) {
    return {
      ok: false,
      error: `scan insert failed: ${insErr?.message ?? 'no row'}`,
    };
  }
  const scanId = scanRow.id;

  // 2. Generate grid + run DataForSEO Live Mode scan.
  const points = generateGridCoordinates({
    centerLat: Number(location.latitude),
    centerLng: Number(location.longitude),
    gridSize: 9,
    radiusMiles: Number(location.service_radius_miles ?? 1.6),
  });
  const firstWord = client.business_name.split(/\s+/)[0]?.toLowerCase() ?? '';
  const ownPattern = new RegExp(firstWord || '___never_match___', 'i');

  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: keyword.keyword,
      points,
      targetMatch: (item) =>
        ownPattern.test((item.title ?? '').toString().toLowerCase()),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from('scans')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', scanId);
    return { ok: false, error: `DFS scan failed: ${msg}`, scanId };
  }

  // 3. Persist scan_points (one row per grid cell with rank + competitors).
  const rows = scan.results.map((r) => ({
    scan_id: scanId,
    grid_x: r.point.x,
    grid_y: r.point.y,
    latitude: r.point.lat,
    longitude: r.point.lng,
    rank: r.rank,
    business_found: r.businessFound,
    competitors: r.items.slice(0, 3).map((it) => ({
      name: it.title ?? null,
      domain: it.domain ?? null,
      rank_group: it.rank_group ?? null,
      rank_absolute: it.rank_absolute ?? null,
      place_id: it.cid ?? null,
    })),
    raw_response: r.raw,
  }));
  const { error: ptsErr } = await supabase.from('scan_points').insert(rows);
  if (ptsErr) {
    await supabase
      .from('scans')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', scanId);
    return {
      ok: false,
      error: `scan_points insert failed: ${ptsErr.message}`,
      scanId,
    };
  }

  // 4. Compute the score family.
  const ranks = scan.results.map((r) => r.rank);
  const totalCells = scan.results.length;
  const reach = turfReach(ranks, totalCells);
  const rank = turfRank(ranks);
  const score = composeTurfScore(reach, rank);
  const found = scan.results.filter((r) => r.businessFound).length;

  // 5. Momentum: compare to most recent prior scan ≥ 12h older for THIS
  //    location. Same-day rescans share a baseline; cross-location data
  //    is excluded.
  const baselineCutoff = new Date(
    Date.now() - MOMENTUM_BASELINE_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();
  const { data: prevScan } = await supabase
    .from('scans')
    .select('turf_score')
    .eq('client_id', client.id)
    .eq('location_id', location.id)
    .eq('status', 'complete')
    .neq('id', scanId)
    .lt('completed_at', baselineCutoff)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ turf_score: number | null }>();
  const momentumValue = computeMomentum(score, prevScan?.turf_score ?? null);

  // 6. Mark scan complete.
  await supabase
    .from('scans')
    .update({
      status: 'complete',
      dfs_cost_cents: scan.dfsCostCents,
      failed_points: scan.failedPoints,
      total_points: scan.results.length,
      turf_score: score,
      turf_reach: reach,
      turf_rank: rank,
      momentum: momentumValue,
      completed_at: new Date().toISOString(),
    })
    .eq('id', scanId);

  // 7. Auto-fire NAP audit for THIS location (best-effort; absorbed errors).
  await maybeRunNapAudit(supabase, client.id, triggeredBy, location.id);

  return {
    ok: true,
    scanId,
    totalPoints: scan.results.length,
    failedPoints: scan.failedPoints,
    dfsCostCents: scan.dfsCostCents,
    found,
    turfScore: score,
    turfReach: reach,
    turfRank: rank,
    momentum: momentumValue,
  };
}
