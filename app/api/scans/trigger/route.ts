/**
 * POST /api/scans/trigger
 *
 * On-demand scan endpoint. Runs a Live Mode DataForSEO scan against the
 * client's pin location for one tracked keyword, persists the scan and 81
 * scan_points, returns the scan_id.
 *
 * Body:
 *   { clientId: string, keywordId?: string }   // keywordId optional; defaults to is_primary=true
 *
 * Response:
 *   200 { scanId, dfsCostCents, totalPoints, failedPoints, found }
 *   4xx { error }
 *
 * Notes:
 *   - Synchronous: the request blocks until the scan completes (~15-30s).
 *     For Phase 3 we'll move this onto a background queue so the UI can
 *     poll for completion.
 *   - Auth: not implemented yet. In Phase 3 this gets gated on a server
 *     session belonging to an agency staff role.
 */

import { NextResponse } from 'next/server';
import dns from 'node:dns';
import { runLiveLocalPackScan } from '@/lib/dataforseo/client';
import { generateGridCoordinates } from '@/lib/dataforseo/grid';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { momentum as computeMomentum } from '@/lib/metrics/momentum';
import { maybeRunNapAudit } from '@/lib/brightlocal/autoAudit';
import type { ClientRow, TrackedKeywordRow } from '@/lib/supabase/types';

// Avoid IPv6 ENOTFOUND flakes on dual-stack networks.
dns.setDefaultResultOrder('ipv4first');

// Force this route onto the Node runtime — it uses dns + Buffer + needs
// long-running fetches that don't fit the Edge runtime model.
export const runtime = 'nodejs';
// Vercel default is 300s on all plans; we explicitly cap to that. DFS scans
// typically finish in 20-50s but the long tail (40207 retries, slow DFS
// upstream) can push closer to 90s; the previous 60s cap could time out
// the Lambda before the response left the function, returning Vercel's
// generic HTML error page that the client couldn't JSON.parse.
export const maxDuration = 300;

export async function POST(req: Request) {
  // Top-level safety net: any uncaught exception below is converted to a
  // 500 JSON envelope so the ScanButton always sees parseable JSON instead
  // of Vercel's generic HTML error page.
  try {
    return await runScanTrigger(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/scans/trigger] unhandled:', msg, e);
    return NextResponse.json(
      { error: `scan trigger crashed: ${msg}` },
      { status: 500 }
    );
  }
}

async function runScanTrigger(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  let body: { clientId?: string; keywordId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { clientId, keywordId } = body;
  if (!clientId) {
    return NextResponse.json(
      { error: 'clientId is required' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // 1. Load client (need lat/lng + business name for the matcher)
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (clientErr || !client) {
    return NextResponse.json(
      { error: `client not found: ${clientErr?.message ?? clientId}` },
      { status: 404 }
    );
  }

  // 2. Resolve keyword (provided id, else primary, else any)
  const keywordQuery = supabase
    .from('tracked_keywords')
    .select('*')
    .eq('client_id', clientId);
  const { data: keywordRow, error: kwErr } = keywordId
    ? await keywordQuery.eq('id', keywordId).maybeSingle<TrackedKeywordRow>()
    : await keywordQuery
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle<TrackedKeywordRow>();
  if (kwErr || !keywordRow) {
    return NextResponse.json(
      { error: 'no tracked keyword found for this client' },
      { status: 400 }
    );
  }

  // 3. Insert scan row in 'running' status
  const { data: scanRow, error: insErr } = await supabase
    .from('scans')
    .insert({
      client_id: clientId,
      keyword_id: keywordRow.id,
      scan_type: 'on_demand',
      grid_size: 9,
      status: 'running',
      total_points: 81,
    })
    .select('id')
    .single();
  if (insErr || !scanRow) {
    return NextResponse.json(
      { error: `scan insert failed: ${insErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }
  const scanId = scanRow.id;

  // 4. Generate grid + run scan
  const points = generateGridCoordinates({
    centerLat: Number(client.latitude),
    centerLng: Number(client.longitude),
    gridSize: 9,
    radiusMiles: Number(client.service_radius_miles ?? 1.6),
  });

  const firstWord = client.business_name.split(/\s+/)[0]?.toLowerCase() ?? '';
  const ownPattern = new RegExp(firstWord || '___never_match___', 'i');

  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: keywordRow.keyword,
      points,
      targetMatch: (item) => {
        const title = (item.title ?? '').toString().toLowerCase();
        return ownPattern.test(title);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from('scans')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', scanId);
    return NextResponse.json(
      { error: `DFS scan failed: ${msg}`, scanId },
      { status: 502 }
    );
  }

  // 5. Persist scan_points
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
    return NextResponse.json(
      { error: `scan_points insert failed: ${ptsErr.message}`, scanId },
      { status: 500 }
    );
  }

  // 6. Compute the new score family. Reach + Rank are derived from
  //    scan_points; TurfScore is the composite. Momentum compares this
  //    scan's TurfScore against the most recent prior complete scan
  //    for this client (null on first scan). Deprecated columns
  //    (top3_win_rate, turf_radius_units) are no longer written.
  const ranks = scan.results.map((r) => r.rank);
  const totalCells = scan.results.length;
  const reach = turfReach(ranks, totalCells);
  const rank = turfRank(ranks);
  const score = composeTurfScore(reach, rank);
  const found = scan.results.filter((r) => r.businessFound).length;

  // Look up the previous complete scan for this client (excluding the
  // current scan). If none exists, momentum is null.
  const { data: prevScan } = await supabase
    .from('scans')
    .select('turf_score')
    .eq('client_id', clientId)
    .eq('status', 'complete')
    .neq('id', scanId)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ turf_score: number | null }>();
  const momentumValue = computeMomentum(score, prevScan?.turf_score ?? null);

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

  // Auto-trigger a NAP audit if there isn't a recent one for this client.
  // Awaits the BL initiate fan-out (~1-2s for ≤15 directories); the audit
  // then progresses asynchronously inside BrightLocal and gets finalized
  // lazily on the next AI Coach generation. Failures are absorbed inside
  // the helper so the scan response is unaffected.
  await maybeRunNapAudit(supabase, clientId, auth.id);

  return NextResponse.json({
    scanId,
    dfsCostCents: scan.dfsCostCents,
    totalPoints: scan.results.length,
    failedPoints: scan.failedPoints,
    found,
    turfScore: score,
    turfReach: reach,
    turfRank: rank,
    momentum: momentumValue,
  });
}
