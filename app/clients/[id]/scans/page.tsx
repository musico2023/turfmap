/**
 * Scan history page — `/clients/[id]/scans`.
 *
 * Two stacked sections:
 *   1. Trend chart of TurfScore + Top-3 Win Rate over time (last 26 entries).
 *   2. Full table of every scan for the client, with PDF + view links.
 *
 * The chart renders the most recent N scans newest-on-the-right; the table
 * lists everything newest-first.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import {
  ScanHistoryTable,
  type ScanHistoryRow,
} from '@/components/turfmap/ScanHistoryTable';
import { TrendChart, type TrendPoint } from '@/components/turfmap/TrendChart';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow, ScanRow } from '@/lib/supabase/types';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';

const TREND_LIMIT = 26;

export default async function ScanHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireAgencyUserOrRedirect(`/clients/${id}/scans`);
  const supabase = getServerSupabase();

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .maybeSingle<ClientRow>();
  if (!client) notFound();

  const { data: rawScans } = await supabase
    .from('scans')
    .select(
      'id, scan_type, status, completed_at, created_at, turf_score, top3_win_rate, turf_radius_units, failed_points, total_points'
    )
    .eq('client_id', id)
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .returns<
      Pick<
        ScanRow,
        | 'id'
        | 'scan_type'
        | 'status'
        | 'completed_at'
        | 'created_at'
        | 'turf_score'
        | 'top3_win_rate'
        | 'turf_radius_units'
        | 'failed_points'
        | 'total_points'
      >[]
    >();

  const scans = rawScans ?? [];

  // Pull the set of scan_ids that have an AI insight so the table can show a
  // sparkle indicator without an N+1 query.
  const scanIds = scans.map((s) => s.id);
  const { data: insightRows } = scanIds.length
    ? await supabase
        .from('ai_insights')
        .select('scan_id')
        .in('scan_id', scanIds)
    : { data: [] };
  const insightScanIds = new Set(
    (insightRows ?? []).map((r) => r.scan_id as string)
  );

  const tableRows: ScanHistoryRow[] = scans.map((s) => ({
    id: s.id,
    scanType: s.scan_type,
    status: s.status ?? 'queued',
    completedAt: s.completed_at,
    createdAt: s.created_at,
    turfScore: s.turf_score === null ? null : Number(s.turf_score),
    top3WinRate: s.top3_win_rate === null ? null : Number(s.top3_win_rate),
    turfRadiusUnits: s.turf_radius_units,
    failedPoints: s.failed_points,
    totalPoints: s.total_points,
    hasInsight: insightScanIds.has(s.id),
  }));

  // Trend chart: only complete scans, oldest-first, capped at TREND_LIMIT.
  const trendPoints: TrendPoint[] = scans
    .filter((s) => s.status === 'complete' && s.completed_at)
    .slice(0, TREND_LIMIT)
    .reverse()
    .map((s) => ({
      scanId: s.id,
      completedAt: s.completed_at!,
      turfScore: s.turf_score === null ? null : Number(s.turf_score),
      top3Pct: Number(s.top3_win_rate ?? 0),
    }));

  const completedCount = trendPoints.length;
  const cronCount = scans.filter((s) => s.scan_type === 'scheduled').length;
  const onDemandCount = scans.filter((s) => s.scan_type === 'on_demand').length;

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to {client.business_name}
        </Link>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold">Scan history</h1>
            <p className="text-xs text-zinc-500 mt-1">
              {scans.length} total · {completedCount} complete · {cronCount}{' '}
              scheduled · {onDemandCount} on-demand
            </p>
          </div>
        </div>

        {/* Trend chart */}
        <div
          className="border rounded-lg p-6 mb-6"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-display text-lg font-bold">
                TurfScore & 3-Pack Win Rate trend
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Last {Math.min(scans.length, TREND_LIMIT)} complete scans —
                lower TurfScore + higher Top-3% is better.
              </p>
            </div>
          </div>
          <TrendChart points={trendPoints} />
        </div>

        {/* Table */}
        <ScanHistoryTable clientId={client.id} rows={tableRows} />
      </div>
    </div>
  );
}
