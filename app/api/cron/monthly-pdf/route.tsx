/**
 * Vercel Cron — monthly PDF report email.
 *
 * Schedule (vercel.json): 1st of every month at 09:00 UTC.
 *
 * For each Pulse / Pulse+ / agency-managed client:
 *   1. Find the latest complete scan per location (most recent scan
 *      across all keywords for that storefront).
 *   2. Render the TurfReport PDF in-process (same code path as
 *      /api/reports/pdf, just without the GET handler).
 *   3. Email it to every client_users.email on the row via Resend.
 *
 * Best-effort per-client. A render or send failure for one client
 * doesn't stop the loop; errors are logged and counted in the
 * response.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *
 * Returns: { processed, sent, errors }
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderToBuffer } from '@react-pdf/renderer';
import { getServerSupabase } from '@/lib/supabase/server';
import { TurfReport, type TurfReportData } from '@/components/pdf/TurfReport';
import { sendMonthlyPdf } from '@/lib/email/resend';
import { withAlertPrefDefaults } from '@/lib/alerts/prefs';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank } from '@/lib/metrics/turfRank';
import { portalUrl as makePortalUrl } from '@/lib/urls';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import type {
  ClientLocationRow,
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Each PDF render takes 1-3s. With ~100 clients in the worst case,
// that's a 5-min worst-case run. The 5min ceiling is safe for v1;
// at scale this should chunk across multiple cron ticks.
export const maxDuration = 300;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 503 }
    );
  }
  if (req.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();

  // Pull every client on a recurring tier (Pulse / Pulse+ / agency-
  // managed). One_time clients (TurfScan / Audit / Strategy) bought a
  // one-shot product — they shouldn't get monthly recurring emails.
  // Also pull alert_prefs so we can honor the per-client opt-out
  // toggle (alert_prefs.monthly_pdf_email).
  const { data: clients } = await supabase
    .from('clients')
    .select('id, public_id, business_name, region, billing_mode, status, alert_prefs')
    .in('billing_mode', ['agency_managed', 'self_serve_subscription'])
    .neq('status', 'churned')
    .returns<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'business_name'
        | 'billing_mode'
        | 'status'
        | 'alert_prefs'
      >[]
    >();

  let processed = 0;
  let sent = 0;
  const errors: Array<{ clientId: string; message: string }> = [];

  for (const client of clients ?? []) {
    processed += 1;
    // Honor the per-client opt-out. Defaults to true (= send) for
    // existing buyers without the field set.
    const prefs = withAlertPrefDefaults(client.alert_prefs ?? null);
    if (!prefs.monthly_pdf_email) continue;
    try {
      const result = await sendMonthlyPdfForClient(supabase, client);
      sent += result.sent;
      if (result.error) {
        errors.push({ clientId: client.id, message: result.error });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ clientId: client.id, message: msg });
    }
  }

  return NextResponse.json({ processed, sent, errors });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

async function sendMonthlyPdfForClient(
  supabase: SupabaseLike,
  client: Pick<ClientRow, 'id' | 'public_id' | 'business_name'>
): Promise<{ sent: number; error: string | null }> {
  // Find the primary location's most recent complete scan. We pick
  // primary because most clients have one location; multi-location
  // operators can still consume the per-location view via dashboard
  // and CSV export. The PDF surface is intentionally one report
  // per client per month.
  const { data: location } = await supabase
    .from('client_locations')
    .select('id, label, city, address, service_radius_miles')
    .eq('client_id', client.id)
    .eq('is_primary', true)
    .maybeSingle<
      Pick<
        ClientLocationRow,
        'id' | 'label' | 'city' | 'address' | 'service_radius_miles'
      >
    >();
  if (!location) return { sent: 0, error: 'no primary location' };

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', client.id)
    .eq('location_id', location.id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();
  if (!scan) return { sent: 0, error: 'no complete scan yet' };

  const [{ data: keyword }, { data: rawPoints }, { data: portalUsers }] =
    await Promise.all([
      supabase
        .from('tracked_keywords')
        .select('id, keyword')
        .eq('id', scan.keyword_id)
        .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword'>>(),
      supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, business_found, competitors')
        .eq('scan_id', scan.id)
        .returns<
          Pick<
            ScanPointRow,
            'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
          >[]
        >(),
      supabase
        .from('client_users')
        .select('email')
        .eq('client_id', client.id)
        .returns<{ email: string }[]>(),
    ]);

  if (!keyword) return { sent: 0, error: 'keyword not found' };

  const points = rawPoints ?? [];
  const cells = points.map((p: typeof points[number]) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p: typeof points[number]) => p.rank);
  const reach =
    scan.turf_reach != null ? Number(scan.turf_reach) : turfReach(ranks);
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
    clientRegion: (client as { region?: string | null }).region ?? null,
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

  // Need logo_url for the PDF header — pull it on a small detour
  // since the client object passed in only carries the columns we
  // already selected at the top of the cron.
  const { data: logoRow } = await supabase
    .from('clients')
    .select('logo_url')
    .eq('id', client.id)
    .maybeSingle<{ logo_url: string | null }>();

  const data: TurfReportData = {
    client: {
      businessName: client.business_name,
      address: location.address ?? '',
      industry: null,
      logoUrl: logoRow?.logo_url ?? null,
    },
    keyword: keyword.keyword,
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
  };

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderToBuffer(<TurfReport data={data} />);
  } catch (e) {
    return {
      sent: 0,
      error: `pdf render failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const recipients = (portalUsers ?? [])
    .map((u: { email: string }) => u.email)
    .filter(Boolean);
  if (recipients.length === 0) {
    return { sent: 0, error: 'no portal users to email' };
  }

  const dateStr = new Date(data.scan.completedAt).toISOString().slice(0, 10);
  const slug = client.business_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const filename = `turfreport-${slug}-${dateStr}.pdf`;

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const portalUrl = makePortalUrl(origin, client.public_id);

  let sent = 0;
  for (const to of recipients) {
    const ok = await sendMonthlyPdf({
      to,
      businessName: client.business_name,
      scanDate: dateStr,
      portalUrl,
      pdf: { filename, content: pdfBuffer },
    });
    if (ok) sent += 1;
  }

  return { sent, error: null };
}
