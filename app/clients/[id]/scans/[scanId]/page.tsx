/**
 * Per-scan permalink — `/clients/[id]/scans/[scanId]`.
 *
 * Renders the same dashboard as `/clients/[id]` but pinned to a specific
 * historical scan instead of "the latest." Used from the scan-history table
 * and from any external link to a specific point in time.
 *
 * Differences vs the latest-scan dashboard:
 *   - "Historical scan" banner up top with a link back to latest
 *   - Re-scan button hidden (you can't re-run a frozen scan)
 *   - PDF + AI Coach still work for the historical scan
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft,
  Crown,
  Download,
  History,
  MapPin,
  Target,
  TrendingUp,
} from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { OUT_OF_PACK_RANK, turfScore } from '@/lib/metrics/turfScore';
import { turfScoreDisplay } from '@/lib/metrics/turfScoreDisplay';
import { top3Rate } from '@/lib/metrics/top3Rate';
import { turfRadius } from '@/lib/metrics/turfRadius';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { Header } from '@/components/turfmap/Header';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import {
  HeatmapWithToggle,
  type CompetitorView,
} from '@/components/turfmap/HeatmapWithToggle';
import { StatCard } from '@/components/turfmap/StatCard';
import { CompetitorTable } from '@/components/turfmap/CompetitorTable';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';

// 9×9 grid = 4 rings out from center; spacing = service_radius / 4.
const RINGS_FROM_CENTER = 4;

export default async function PerScanPage({
  params,
}: {
  params: Promise<{ id: string; scanId: string }>;
}) {
  const { id, scanId } = await params;
  const me = await requireAgencyUserOrRedirect(`/clients/${id}/scans/${scanId}`);
  const supabase = getServerSupabase();

  // Load client + scan + keyword in parallel
  const [{ data: client }, { data: scan }] = await Promise.all([
    supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .maybeSingle<ClientRow>(),
    supabase
      .from('scans')
      .select('*')
      .eq('id', scanId)
      .eq('client_id', id)
      .maybeSingle<ScanRow>(),
  ]);
  if (!client || !scan) notFound();

  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('id', scan.keyword_id)
    .maybeSingle<TrackedKeywordRow>();

  const { data: rawPoints } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, business_found, competitors')
    .eq('scan_id', scan.id)
    .returns<
      Pick<
        ScanPointRow,
        'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
      >[]
    >();
  const points = rawPoints ?? [];

  const cells: HeatmapCell[] = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);
  const score =
    scan.turf_score !== null && scan.turf_score !== undefined
      ? Number(scan.turf_score)
      : turfScore(ranks);
  const t3 = scan.top3_win_rate !== null ? Number(scan.top3_win_rate) : top3Rate(ranks);
  const radiusUnits =
    scan.turf_radius_units ??
    turfRadius(
      points.map((p) => ({
        point: { x: p.grid_x, y: p.grid_y },
        rank: p.rank,
      })),
      9,
      OUT_OF_PACK_RANK
    );

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  // Fetch the most recent insight for this specific scan (if any).
  const { data: insightRow } = await supabase
    .from('ai_insights')
    .select('diagnosis, actions, projected_impact')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      diagnosis: string;
      actions: AICoachAction[];
      projected_impact: string | null;
    }>();

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      {/* Historical-scan banner */}
      <div
        className="border-b px-8 py-3 flex items-center justify-between text-xs"
        style={{
          background: '#0f1208',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <div className="flex items-center gap-2 text-zinc-300">
          <History size={13} style={{ color: 'var(--color-lime)' }} />
          <span>
            Viewing historical scan from{' '}
            <span className="font-mono">
              {new Date(scan.completed_at ?? scan.created_at!)
                .toISOString()
                .replace('T', ' ')
                .slice(0, 16)}{' '}
              UTC
            </span>
          </span>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-mono"
            style={{
              background: '#1a2010',
              color: 'var(--color-lime)',
              border: '1px solid var(--color-border-bright)',
            }}
          >
            {scan.scan_type === 'scheduled' ? 'cron' : 'on-demand'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href={`/clients/${client.id}/scans`}
            className="text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1"
          >
            <ChevronLeft size={12} /> All scans
          </Link>
          <Link
            href={`/clients/${client.id}`}
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            View latest →
          </Link>
        </div>
      </div>

      {/* Business meta */}
      <div
        className="border-b px-8 py-4 grid grid-cols-12 gap-4 items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Business
          </div>
          <div className="text-sm font-medium text-zinc-100">
            {client.business_name}
          </div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Pin Location
          </div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200">
            <MapPin size={13} className="text-zinc-500" />
            {client.address}
          </div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Tracking Keyword
          </div>
          <div className="text-sm font-mono text-zinc-200">
            {keyword?.keyword ?? '—'}
          </div>
        </div>
        <div className="col-span-3 flex justify-end">
          <a
            href={`/api/reports/pdf?scanId=${scan.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-card)',
            }}
          >
            <Download size={12} /> PDF
          </a>
        </div>
      </div>

      {/* Heatmap + Stats */}
      <div className="grid grid-cols-12 gap-6 p-8">
        <div
          className="col-span-8 border rounded-lg p-6 relative overflow-hidden"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-display text-xl font-bold">
                Territory Heatmap
              </h3>
              <p className="text-xs text-zinc-500">
                9×9 geo-grid · 81 search points · 1.6mi radius · UULE-based
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
              {[
                { color: '#c5ff3a', label: 'Top 3' },
                { color: '#e8e54a', label: '4–10' },
                { color: '#ff9f3a', label: '11–20' },
                { color: '#ff4d4d', label: '21+' },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: item.color }}
                  />
                  <span className="text-zinc-400">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <HeatmapWithToggle
            clientCells={cells}
            clientName={client.business_name}
            competitors={competitors.map((c): CompetitorView => ({
              ...c,
              cells: buildCompetitorCells(points, c.name),
            }))}
          />
        </div>

        <div className="col-span-4 space-y-4">
          <StatCard
            label="TurfScore™"
            value={score === null ? '—' : `${turfScoreDisplay(score)}`}
            subtitle="0–100 · higher is better"
            icon={Target}
          />
          <StatCard
            label="3-Pack Win Rate"
            value={`${t3}%`}
            subtitle="% of 81 cells where you rank in the local 3-pack"
            icon={Crown}
            highlight
          />
          <StatCard
            label="TurfRadius™"
            value={`${(
              radiusUnits *
              ((client.service_radius_miles ?? 1.6) / RINGS_FROM_CENTER)
            ).toFixed(1)}mi`}
            subtitle="Furthest distance from your pin where you reach the 3-pack"
            icon={TrendingUp}
          />
          <CompetitorTable competitors={competitors} />
        </div>

        <div className="col-span-12">
          <AICoach
            scanId={scan.id}
            insight={insightRow ?? null}
            scanComplete={scan.status === 'complete'}
          />
        </div>
      </div>

      <footer
        className="border-t px-8 py-4 flex items-center justify-between text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span>
          © Local Lead Machine · TurfMap™ is proprietary technology of Fourdots
          Digital
        </span>
        <span className="font-mono">
          Scan {scan.id.slice(0, 8)} · {scan.failed_points ?? 0} failed pts ·
          ${((scan.dfs_cost_cents ?? 0) / 100).toFixed(2)} DFS
        </span>
      </footer>
    </div>
  );
}
