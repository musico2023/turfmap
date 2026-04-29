/**
 * Vercel Cron — weekly scheduled scans.
 *
 * Schedule (vercel.json): every Monday at 06:00 UTC.
 *
 * For each active client with a tracked keyword that has
 * scan_frequency='weekly', runs a Live Mode scan and persists the result
 * as scan_type='scheduled'. Idempotent within a UTC day — if a scheduled
 * scan for the same (client, keyword) pair was already run today, it's
 * skipped.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel Cron adds this
 * automatically when CRON_SECRET is set in the project's env.
 *
 * v1 scope:
 *   - Sequential execution (one scan at a time). Fits within 60s function
 *     timeout for ~1-2 clients on Live Mode (~30s per scan).
 *   - Live Mode at $0.002/req. The spec eventually wants Standard Queue
 *     (~$0.0006/req) for scheduled scans — TODO when we cross 5+ clients.
 *
 * Returns: { triggered, skipped, errors, results: [{clientId, keywordId, scanId, error?}] }
 */

import { NextResponse } from 'next/server';
import dns from 'node:dns';
import { runLiveLocalPackScan } from '@/lib/dataforseo/client';
import { generateGridCoordinates } from '@/lib/dataforseo/grid';
import { getServerSupabase } from '@/lib/supabase/server';
import { turfScore } from '@/lib/metrics/turfScore';
import { top3Rate } from '@/lib/metrics/top3Rate';
import { turfRadius } from '@/lib/metrics/turfRadius';
import type {
  ClientRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

dns.setDefaultResultOrder('ipv4first');

export const runtime = 'nodejs';
export const maxDuration = 60;

type RunResult = {
  clientId: string;
  keywordId: string;
  scanId?: string;
  error?: string;
  skipped?: 'already_ran_today';
};

/**
 * Verify the request came from Vercel Cron (or a manually authorized caller
 * sharing the secret). If CRON_SECRET is unset we refuse — fail closed.
 */
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

  // 1. Find all (client, weekly keyword) pairs to scan.
  const { data: keywords, error: kwErr } = await supabase
    .from('tracked_keywords')
    .select('id, client_id, keyword')
    .eq('scan_frequency', 'weekly')
    .returns<Pick<TrackedKeywordRow, 'id' | 'client_id' | 'keyword'>[]>();
  if (kwErr) {
    return NextResponse.json(
      { error: `keyword query failed: ${kwErr.message}` },
      { status: 500 }
    );
  }

  // Filter to active clients only. One join would be cleaner; doing two
  // queries keeps the code readable for v1.
  const clientIds = [...new Set((keywords ?? []).map((k) => k.client_id))];
  const { data: activeClients } = await supabase
    .from('clients')
    .select('*')
    .in('id', clientIds)
    .eq('status', 'active')
    .returns<ClientRow[]>();
  const clientById = new Map((activeClients ?? []).map((c) => [c.id, c]));

  const work = (keywords ?? []).filter((k) => clientById.has(k.client_id));

  // 2. Execute sequentially.
  const results: RunResult[] = [];
  let triggered = 0;
  let skipped = 0;
  let errors = 0;

  for (const kw of work) {
    const client = clientById.get(kw.client_id);
    if (!client) continue; // shouldn't happen given the filter above
    const result = await runScheduledScan(client, kw, supabase);
    results.push(result);
    if (result.skipped) skipped++;
    else if (result.error) errors++;
    else triggered++;
  }

  return NextResponse.json({
    triggered,
    skipped,
    errors,
    results,
    runAt: new Date().toISOString(),
  });
}

async function runScheduledScan(
  client: ClientRow,
  kw: Pick<TrackedKeywordRow, 'id' | 'client_id' | 'keyword'>,
  supabase: ReturnType<typeof getServerSupabase>
): Promise<RunResult> {
  // Idempotency — skip if a scheduled scan for this pair was already run today (UTC).
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);
  const { data: existing } = await supabase
    .from('scans')
    .select('id')
    .eq('client_id', client.id)
    .eq('keyword_id', kw.id)
    .eq('scan_type', 'scheduled')
    .gte('created_at', todayStartUtc.toISOString())
    .limit(1)
    .maybeSingle<Pick<ScanRow, 'id'>>();
  if (existing) {
    return {
      clientId: client.id,
      keywordId: kw.id,
      scanId: existing.id,
      skipped: 'already_ran_today',
    };
  }

  // Insert running scan row
  const { data: scanRow, error: insErr } = await supabase
    .from('scans')
    .insert({
      client_id: client.id,
      keyword_id: kw.id,
      scan_type: 'scheduled',
      grid_size: 9,
      status: 'running',
      total_points: 81,
    })
    .select('id')
    .single();
  if (insErr || !scanRow) {
    return {
      clientId: client.id,
      keywordId: kw.id,
      error: `scan insert failed: ${insErr?.message ?? 'no row'}`,
    };
  }
  const scanId = scanRow.id;

  // Generate grid + run scan
  const points = generateGridCoordinates({
    centerLat: Number(client.latitude),
    centerLng: Number(client.longitude),
    gridSize: 9,
    radiusMiles: Number(client.service_radius_miles ?? 1.6),
  });
  const ownPattern = new RegExp(
    client.business_name.split(/\s+/)[0]?.toLowerCase() || '___never_match___',
    'i'
  );

  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: kw.keyword,
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
    return { clientId: client.id, keywordId: kw.id, scanId, error: msg };
  }

  // Persist points
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
      clientId: client.id,
      keywordId: kw.id,
      scanId,
      error: `scan_points insert failed: ${ptsErr.message}`,
    };
  }

  // Compute + persist metrics
  const ranks = scan.results.map((r) => r.rank);
  const score = turfScore(ranks);
  const t3 = top3Rate(ranks);
  const radius = turfRadius(
    scan.results.map((r) => ({
      point: { x: r.point.x, y: r.point.y },
      rank: r.rank,
    }))
  );
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

  return { clientId: client.id, keywordId: kw.id, scanId };
}
