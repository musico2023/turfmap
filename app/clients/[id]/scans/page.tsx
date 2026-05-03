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
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import {
  listLocations,
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import { LocationSwitcher } from '@/components/turfmap/LocationSwitcher';
import type { ScanRow } from '@/lib/supabase/types';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';

const TREND_LIMIT = 26;

export default async function ScanHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam } = await searchParams;
  const me = await requireAgencyUserOrRedirect(`/clients/${clientParam}/scans`);
  const supabase = getServerSupabase();

  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) notFound();
  const id = client.id; // canonical UUID for FK queries

  // Multi-location: scope the entire history view to one location at a
  // time. Without this, multi-location clients see Don Mills scans
  // mashed into Midtown's trend line and the table — junk-trend data.
  const locations = await listLocations(supabase, id);
  const activeLocation =
    (await resolveLocation(supabase, id, locationParam ?? null)) ??
    locations[0] ??
    null;

  const { data: rawScans } = await supabase
    .from('scans')
    .select(
      'id, scan_type, status, completed_at, created_at, turf_score, turf_reach, turf_rank, momentum, failed_points, total_points'
    )
    .eq('client_id', id)
    .eq('location_id', activeLocation?.id ?? '')
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
        | 'turf_reach'
        | 'turf_rank'
        | 'momentum'
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
    turfReach: s.turf_reach === null ? null : Number(s.turf_reach),
    turfRank: s.turf_rank === null ? null : Number(s.turf_rank),
    momentum: s.momentum === null ? null : Number(s.momentum),
    failedPoints: s.failed_points,
    totalPoints: s.total_points,
    hasInsight: insightScanIds.has(s.id),
  }));

  // Trend chart: only complete scans, oldest-first, capped at TREND_LIMIT.
  // Plots TurfScore (left axis, composite 0-100) + TurfReach % (right
  // axis, 0-100). The chart's `top3Pct` field is plumbed with TurfReach
  // values — name preserved in the component for binding compatibility.
  const trendPoints: TrendPoint[] = scans
    .filter((s) => s.status === 'complete' && s.completed_at)
    .slice(0, TREND_LIMIT)
    .reverse()
    .map((s) => ({
      scanId: s.id,
      completedAt: s.completed_at!,
      turfScore: s.turf_score === null ? null : Number(s.turf_score),
      top3Pct: Number(s.turf_reach ?? 0),
    }));

  const completedCount = trendPoints.length;
  const cronCount = scans.filter((s) => s.scan_type === 'scheduled').length;
  const onDemandCount = scans.filter((s) => s.scan_type === 'on_demand').length;

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6">
        <Link
          href={`/clients/${client.public_id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to {client.business_name}
        </Link>

        {locations.length > 1 && (
          <div className="mb-5">
            <LocationSwitcher
              clientId={client.public_id}
              locations={locations}
              activeLocationId={activeLocation?.id ?? null}
            />
          </div>
        )}

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold">
              Scan history
              {activeLocation && !activeLocation.is_primary && (
                <span className="text-zinc-500 font-normal text-base ml-2">
                  · {locationDisplayLabel(activeLocation)}
                </span>
              )}
            </h1>
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
                Last {Math.min(scans.length, TREND_LIMIT)} complete scans.
                Both lines move up when things improve.
              </p>
            </div>
          </div>
          <TrendChart points={trendPoints} />
        </div>

        {/* Table */}
        <ScanHistoryTable clientId={client.public_id} rows={tableRows} />
      </div>
    </div>
  );
}
