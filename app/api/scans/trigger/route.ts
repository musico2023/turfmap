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
import { turfScore } from '@/lib/metrics/turfScore';
import { top3Rate } from '@/lib/metrics/top3Rate';
import { turfRadius } from '@/lib/metrics/turfRadius';
import type { ClientRow, TrackedKeywordRow } from '@/lib/supabase/types';

// Avoid IPv6 ENOTFOUND flakes on dual-stack networks.
dns.setDefaultResultOrder('ipv4first');

// Force this route onto the Node runtime — it uses dns + Buffer + needs
// long-running fetches that don't fit the Edge runtime model.
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
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

  // 6. Compute + persist metrics
  const ranks = scan.results.map((r) => r.rank);
  const score = turfScore(ranks);
  const t3 = top3Rate(ranks);
  const radius = turfRadius(
    scan.results.map((r) => ({ point: { x: r.point.x, y: r.point.y }, rank: r.rank }))
  );
  const found = scan.results.filter((r) => r.businessFound).length;

  await supabase
    .from('scans')
    .update({
      status: 'complete',
      dfs_cost_cents: scan.dfsCostCents,
      failed_points: scan.failedPoints,
      total_points: scan.results.length,
      turf_score: score,
      top3_win_rate: t3,
      turf_radius_units: radius,
      completed_at: new Date().toISOString(),
    })
    .eq('id', scanId);

  return NextResponse.json({
    scanId,
    dfsCostCents: scan.dfsCostCents,
    totalPoints: scan.results.length,
    failedPoints: scan.failedPoints,
    found,
    turfScore: score,
    top3Pct: t3,
    radiusUnits: radius,
  });
}
