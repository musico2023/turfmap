/**
 * GET /api/exports/looker?token=<looker_token>
 *
 * Looker Studio + Google Sheets data export. Returns the same scan
 * history that /api/exports/csv produces, shaped as JSON so the
 * Looker community connector (or a Sheets `=IMPORTDATA` formula
 * pointing at the .csv variant) can pull it.
 *
 * Auth: per-client `looker_token` query param. Generated and stored
 * on clients.looker_token via the dedicated /api/clients/[id]/looker-token
 * endpoint. NO agency cookie needed — Looker is pulling without an
 * authenticated session.
 *
 * Security note: the token is the only credential. Treat it like a
 * read-only API key. The settings UI lets the operator regenerate it
 * (which invalidates any old links). Tokens are 32 chars random, so
 * brute force isn't realistic at this surface.
 *
 * Schema (one record per scan × cell, mirrors the CSV columns):
 *   { scan_id, completed_at, location_id, location_label, keyword,
 *     turf_score, turf_reach, turf_rank, momentum,
 *     grid_x, grid_y, cell_rank, business_found }
 *
 * Response shape:
 *   {
 *     business_name: string,
 *     generated_at: iso8601,
 *     row_count: number,
 *     rows: Row[]
 *   }
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import type {
  ClientLocationRow,
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

type LookerRow = {
  scan_id: string;
  completed_at: string | null;
  location_id: string | null;
  location_label: string;
  keyword: string;
  turf_score: number | null;
  turf_reach: number | null;
  turf_rank: number | null;
  momentum: number | null;
  grid_x: number;
  grid_y: number;
  cell_rank: number | null;
  business_found: boolean;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const { data: client } = await supabase
    .from('clients')
    .select('id, business_name')
    .eq('looker_token', token)
    .maybeSingle<Pick<ClientRow, 'id' | 'business_name'>>();
  if (!client) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  const [{ data: scans }, { data: locations }] = await Promise.all([
    supabase
      .from('scans')
      .select(
        'id, completed_at, location_id, keyword_id, turf_score, turf_reach, turf_rank, momentum'
      )
      .eq('client_id', client.id)
      .eq('status', 'complete')
      .order('completed_at', { ascending: false })
      .returns<
        Pick<
          ScanRow,
          | 'id'
          | 'completed_at'
          | 'location_id'
          | 'keyword_id'
          | 'turf_score'
          | 'turf_reach'
          | 'turf_rank'
          | 'momentum'
        >[]
      >(),
    supabase
      .from('client_locations')
      .select('id, label, city')
      .eq('client_id', client.id)
      .returns<Pick<ClientLocationRow, 'id' | 'label' | 'city'>[]>(),
  ]);

  const scanList = scans ?? [];
  if (scanList.length === 0) {
    return NextResponse.json({
      business_name: client.business_name,
      generated_at: new Date().toISOString(),
      row_count: 0,
      rows: [],
    });
  }

  const scanIds = scanList.map((s) => s.id);
  const keywordIds = Array.from(new Set(scanList.map((s) => s.keyword_id)));
  const [{ data: cells }, { data: keywords }] = await Promise.all([
    supabase
      .from('scan_points')
      .select('scan_id, grid_x, grid_y, rank, business_found')
      .in('scan_id', scanIds)
      .returns<
        Pick<
          ScanPointRow,
          'scan_id' | 'grid_x' | 'grid_y' | 'rank' | 'business_found'
        >[]
      >(),
    supabase
      .from('tracked_keywords')
      .select('id, keyword')
      .in('id', keywordIds)
      .returns<Pick<TrackedKeywordRow, 'id' | 'keyword'>[]>(),
  ]);

  const keywordById = new Map((keywords ?? []).map((k) => [k.id, k.keyword]));
  const locationLabelById = new Map(
    (locations ?? []).map((l) => [l.id, l.label || l.city || 'Primary'])
  );
  const cellsByScan = new Map<
    string,
    Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank' | 'business_found'>[]
  >();
  for (const c of cells ?? []) {
    const arr = cellsByScan.get(c.scan_id) ?? [];
    arr.push(c);
    cellsByScan.set(c.scan_id, arr);
  }

  const rows: LookerRow[] = [];
  for (const scan of scanList) {
    const scanCells = cellsByScan.get(scan.id) ?? [];
    for (const c of scanCells) {
      rows.push({
        scan_id: scan.id,
        completed_at: scan.completed_at ?? null,
        location_id: scan.location_id ?? null,
        location_label: locationLabelById.get(scan.location_id ?? '') ?? '',
        keyword: keywordById.get(scan.keyword_id) ?? '',
        turf_score: numberOrNull(scan.turf_score),
        turf_reach: numberOrNull(scan.turf_reach),
        turf_rank: numberOrNull(scan.turf_rank),
        momentum: numberOrNull(scan.momentum),
        grid_x: c.grid_x,
        grid_y: c.grid_y,
        cell_rank: c.rank ?? null,
        business_found: Boolean(c.business_found),
      });
    }
  }

  return NextResponse.json({
    business_name: client.business_name,
    generated_at: new Date().toISOString(),
    row_count: rows.length,
    rows,
  });
}

function numberOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}
