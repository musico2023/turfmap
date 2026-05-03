/**
 * GET /api/reports/pdf?scanId=<uuid>
 *
 * Renders a branded TurfReport PDF for the given scan and streams it back.
 * Pulls client metadata, scan stats, scan_points, competitors, and the
 * latest AI insight (if any) — same data the dashboard renders.
 *
 * Returns: application/pdf with a Content-Disposition that suggests a
 * sensible filename based on the business name + scan date.
 */

import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { TurfReport, type TurfReportData } from '@/components/pdf/TurfReport';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;


export async function GET(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const url = new URL(req.url);
  const scanId = url.searchParams.get('scanId');
  if (!scanId) {
    return Response.json({ error: 'scanId is required' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', scanId)
    .maybeSingle<ScanRow>();
  if (!scan) {
    return Response.json({ error: 'scan not found' }, { status: 404 });
  }

  const [{ data: client }, { data: keyword }, { data: rawPoints }] =
    await Promise.all([
      supabase
        .from('clients')
        .select('*')
        .eq('id', scan.client_id)
        .maybeSingle<ClientRow>(),
      supabase
        .from('tracked_keywords')
        .select('*')
        .eq('id', scan.keyword_id)
        .maybeSingle<TrackedKeywordRow>(),
      supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, competitors')
        .eq('scan_id', scan.id)
        .returns<
          Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank' | 'competitors'>[]
        >(),
    ]);

  if (!client || !keyword) {
    return Response.json(
      { error: 'client or keyword missing' },
      { status: 500 }
    );
  }

  const points = rawPoints ?? [];
  const cells = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);

  // Read persisted columns when populated; recompute from scan_points
  // as a defensive fallback during the score-redesign transition.
  const reach =
    scan.turf_reach != null
      ? Number(scan.turf_reach)
      : turfReach(ranks, scan.total_points ?? 81);
  const rank =
    scan.turf_rank != null ? Number(scan.turf_rank) : turfRank(ranks);
  const score =
    scan.turf_score != null
      ? Number(scan.turf_score)
      : composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  const { data: insightRow } = await supabase
    .from('ai_insights')
    .select('diagnosis, actions, projected_impact')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      diagnosis: string;
      actions: TurfReportData['insight'] extends infer T
        ? T extends { actions: infer A }
          ? A
          : never
        : never;
      projected_impact: string | null;
    }>();

  const data: TurfReportData = {
    client: {
      businessName: client.business_name,
      address: client.address,
      industry: client.industry,
    },
    keyword: keyword.keyword,
    scan: {
      id: scan.id,
      completedAt: scan.completed_at ?? scan.created_at ?? new Date().toISOString(),
      totalPoints: scan.total_points ?? cells.length,
      failedPoints: scan.failed_points ?? 0,
      dfsCostCents: scan.dfs_cost_cents ?? 0,
    },
    metrics: {
      turfScore: score,
      turfScoreBand: { label: band.label, tone: band.tone },
      turfReach: reach,
      turfRank: rank,
      momentum: scan.momentum != null ? Number(scan.momentum) : null,
    },
    cells,
    competitors,
    insight: insightRow
      ? {
          diagnosis: insightRow.diagnosis,
          actions: insightRow.actions,
          projectedImpact: insightRow.projected_impact,
        }
      : null,
  };

  let pdfBuffer: Buffer;
  try {
    // renderToBuffer returns a Buffer — Node-only API, requires runtime: 'nodejs'.
    pdfBuffer = await renderToBuffer(<TurfReport data={data} />);
  } catch (e) {
    return Response.json(
      { error: `pdf render failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  const dateStr = new Date(data.scan.completedAt).toISOString().slice(0, 10);
  const slug = client.business_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const filename = `turfreport-${slug}-${dateStr}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(pdfBuffer.byteLength),
      'Cache-Control': 'private, no-store',
    },
  });
}
