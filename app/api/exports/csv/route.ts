/**
 * GET /api/exports/csv?client_id=<uuid>&location_id=<uuid>?
 *
 * Pulse+ raw-data CSV export. One row per (scan, grid cell) for the
 * client (optionally scoped to a single location). Streams a CSV
 * file the buyer can pull into Excel / Google Sheets / Looker.
 *
 * Auth: agency-gated. The Looker community connector hits the
 * separate /api/exports/looker endpoint which uses a per-client
 * token instead.
 *
 * Response: text/csv with Content-Disposition: attachment.
 *
 * Performance: queries the scan_points join in a single round-trip
 * and renders the CSV in-memory. 50 scans × 81 cells × ~10 cols
 * = ~40k rows, well within Node.js / Vercel function memory.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type {
  ClientLocationRow,
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Up to 50 scans × 81 cells per export. ~40k rows. Sub-second
// generation locally; 60s ceiling is generous headroom on Vercel.
export const maxDuration = 60;

const Q = z.object({
  client_id: z.string().uuid(),
  location_id: z.string().uuid().optional(),
});

const CSV_COLUMNS = [
  'scan_id',
  'completed_at',
  'location_id',
  'location_label',
  'keyword',
  'turf_score',
  'turf_reach',
  'turf_rank',
  'momentum',
  'grid_x',
  'grid_y',
  'cell_rank',
  'business_found',
] as const;

export async function GET(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  let parsed: z.infer<typeof Q>;
  try {
    parsed = Q.parse({
      client_id: url.searchParams.get('client_id'),
      location_id: url.searchParams.get('location_id') ?? undefined,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // Pull the client (for filename slug) and the scans + cells +
  // keyword + location joins. Two queries (scans, then scan_points
  // for those scan ids) — simpler than a server-side join given
  // Postgrest's foreign-table syntax limits.
  const [{ data: client }, { data: locations }, scansQuery] =
    await Promise.all([
      supabase
        .from('clients')
        .select('id, business_name')
        .eq('id', parsed.client_id)
        .maybeSingle<Pick<ClientRow, 'id' | 'business_name'>>(),
      supabase
        .from('client_locations')
        .select('id, label, city')
        .eq('client_id', parsed.client_id)
        .returns<Pick<ClientLocationRow, 'id' | 'label' | 'city'>[]>(),
      (async () => {
        let q = supabase
          .from('scans')
          .select(
            'id, completed_at, location_id, keyword_id, turf_score, turf_reach, turf_rank, momentum, status'
          )
          .eq('client_id', parsed.client_id)
          .eq('status', 'complete')
          .order('completed_at', { ascending: false });
        if (parsed.location_id) q = q.eq('location_id', parsed.location_id);
        return q.returns<
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
            | 'status'
          >[]
        >();
      })(),
    ]);

  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const scans = scansQuery.data ?? [];
  if (scans.length === 0) {
    // Empty export still returns a valid CSV (header row only) so
    // Looker / Sheets clients don't blow up parsing an empty body.
    return csvResponse(toCsv([CSV_COLUMNS as unknown as string[]]), client.business_name);
  }

  const scanIds = scans.map((s) => s.id);
  const keywordIds = Array.from(new Set(scans.map((s) => s.keyword_id)));
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

  // Build rows — header + (one per cell across all scans).
  const rows: string[][] = [CSV_COLUMNS as unknown as string[]];
  for (const scan of scans) {
    const scanCells = cellsByScan.get(scan.id) ?? [];
    for (const c of scanCells) {
      rows.push([
        scan.id,
        scan.completed_at ?? '',
        scan.location_id ?? '',
        locationLabelById.get(scan.location_id ?? '') ?? '',
        keywordById.get(scan.keyword_id) ?? '',
        scan.turf_score == null ? '' : String(scan.turf_score),
        scan.turf_reach == null ? '' : String(scan.turf_reach),
        scan.turf_rank == null ? '' : String(scan.turf_rank),
        scan.momentum == null ? '' : String(scan.momentum),
        String(c.grid_x),
        String(c.grid_y),
        c.rank == null ? '' : String(c.rank),
        c.business_found ? 'true' : 'false',
      ]);
    }
  }

  return csvResponse(toCsv(rows), client.business_name);
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function csvCell(v: string): string {
  if (v == null) return '';
  // RFC-4180-ish: wrap in quotes when the cell contains comma /
  // quote / newline; double up internal quotes.
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function csvResponse(body: string, businessName: string): Response {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const today = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="turfmap-${slug}-${today}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
