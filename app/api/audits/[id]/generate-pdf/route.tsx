/**
 * POST /api/audits/[id]/generate-pdf
 *
 * Renders the customized strategist PDF for an audit-tier order +
 * uploads it to the `audit-deliveries` Supabase Storage bucket. Returns
 * the public URL for the operator to copy into the manual delivery
 * email (Phase 1).
 *
 * The customized PDF = the standard auto-PDF (heatmap + scorecards +
 * AI Coach playbook) PLUS a third page rendering the strategist_notes
 * field as parsed-block markdown.
 *
 * Idempotent: re-generating overwrites the same Storage path
 * (audit-deliveries/<lead_order_id>.pdf), so the public URL stays
 * stable. Old links to that URL keep working with the latest content.
 *
 * Requires:
 *   - Migration 0008 (lead_orders table + clients.billing_mode)
 *   - Migration 0009 (lead_orders.strategist_notes / delivery_pdf_url)
 *   - Storage bucket `audit-deliveries` (run `npm run init:storage`)
 *
 * Failure modes:
 *   - 404 if order not found
 *   - 400 if order isn't an audit-tier
 *   - 422 if strategist_notes is empty (operator must write notes
 *     before generating)
 *   - 422 if no completed scan exists yet for the buyer's client
 *   - 502 if Storage upload fails (Storage misconfigured / bucket
 *     missing)
 */

import { NextResponse, type NextRequest } from 'next/server';
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
  LeadOrderRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const STORAGE_BUCKET = 'audit-deliveries';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const supabase = getServerSupabase();

  // ─── 1. Load + validate the lead_orders row ───────────────────────
  const { data: order } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle<LeadOrderRow>();

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }
  if (order.tier !== 'audit' && order.tier !== 'strategy') {
    return NextResponse.json(
      {
        error: `order tier "${order.tier}" doesn't generate a strategist PDF`,
      },
      { status: 400 }
    );
  }
  if (!order.strategist_notes || order.strategist_notes.trim().length === 0) {
    return NextResponse.json(
      {
        error:
          'strategist notes are empty — write the diagnosis before generating the PDF',
      },
      { status: 422 }
    );
  }
  if (!order.client_id) {
    return NextResponse.json(
      {
        error:
          'order has no associated client — fulfillment may not have completed',
      },
      { status: 422 }
    );
  }

  // ─── 2. Load the buyer's client + most recent completed scan ──────
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', order.client_id)
    .maybeSingle<ClientRow>();

  if (!client) {
    return NextResponse.json(
      { error: 'client row missing for this order' },
      { status: 404 }
    );
  }

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', client.id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();

  if (!scan) {
    return NextResponse.json(
      {
        error:
          'no completed scan yet for this buyer — the fulfill flow may still be running. Try again in a minute.',
      },
      { status: 422 }
    );
  }

  // ─── 3. Build the TurfReportData (same shape as /api/reports/pdf) ─
  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('id', scan.keyword_id)
    .maybeSingle<TrackedKeywordRow>();

  const { data: rawPoints } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, business_found, competitors')
    .eq('scan_id', scan.id);
  const points = rawPoints ?? [];
  const cells = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);

  const reach =
    scan.turf_reach != null ? Number(scan.turf_reach) : turfReach(ranks);
  const rank =
    scan.turf_rank != null ? Number(scan.turf_rank) : turfRank(ranks);
  const score =
    scan.turf_score != null ? Number(scan.turf_score) : composeTurfScore(reach, rank);
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
      actions: NonNullable<TurfReportData['insight']>['actions'];
      projected_impact: string | null;
    }>();

  const data: TurfReportData = {
    client: {
      businessName: client.business_name,
      address: client.address,
      industry: client.industry,
    },
    keyword: keyword?.keyword ?? '—',
    scan: {
      id: scan.id,
      completedAt:
        scan.completed_at ?? scan.created_at ?? new Date().toISOString(),
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
    // The strategist contribution — extends the standard PDF with a
    // third page rendering the markdown notes.
    strategistNotes: order.strategist_notes,
  };

  // ─── 4. Render the PDF ───────────────────────────────────────────
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderToBuffer(<TurfReport data={data} />);
  } catch (e) {
    return NextResponse.json(
      {
        error: `PDF render failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 }
    );
  }

  // ─── 5. Upload to Supabase Storage ────────────────────────────────
  // Path is stable per lead_order — re-generation overwrites at the
  // same URL so old links keep working.
  const storagePath = `${order.id}.pdf`;
  // upsert: true is critical here — without it, the second
  // generation 409s instead of overwriting.
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: 'no-cache',
    });

  if (uploadError) {
    // Distinguish the most common operator error (bucket missing) so
    // the inline error in the dashboard is actionable.
    const isBucketMissing = uploadError.message
      .toLowerCase()
      .includes('not found');
    return NextResponse.json(
      {
        error: isBucketMissing
          ? `Storage bucket "${STORAGE_BUCKET}" missing. Run \`npm run init:storage\` to create it.`
          : `Storage upload failed: ${uploadError.message}`,
      },
      { status: 502 }
    );
  }

  // Public URL — bucket is configured public-read in init-storage.
  const {
    data: { publicUrl },
  } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

  // ─── 6. Persist the URL on the lead_orders row ────────────────────
  const { error: updateError } = await supabase
    .from('lead_orders')
    .update({ delivery_pdf_url: publicUrl })
    .eq('id', order.id);

  if (updateError) {
    // Non-fatal — the file is uploaded, we just couldn't record it.
    // Return the URL anyway; operator can use it.
    console.error(
      '[audits/generate-pdf] persist delivery_pdf_url failed (non-fatal)',
      updateError
    );
  }

  return NextResponse.json({
    ok: true,
    url: publicUrl,
    storagePath,
  });
}
