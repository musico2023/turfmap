import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Crown, Download, History, MapPin, Settings, Target, TrendingUp } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { turfScore, OUT_OF_PACK_RANK } from '@/lib/metrics/turfScore';
import { top3Rate } from '@/lib/metrics/top3Rate';
import { turfRadius } from '@/lib/metrics/turfRadius';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { aggregateCuratedCompetitors } from '@/lib/metrics/curatedCompetitors';
import { Header } from '@/components/turfmap/Header';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { HeatmapWithToggle, type CompetitorView } from '@/components/turfmap/HeatmapWithToggle';
import { StatCard } from '@/components/turfmap/StatCard';
import { CompetitorTable } from '@/components/turfmap/CompetitorTable';
import { ScanButton } from '@/components/turfmap/ScanButton';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';

// Default 9×9 grid is 4 rings out from the center cell, so spacing per ring
// is `service_radius_miles / 4`. Falls back to the v1 default of 1.6mi /
// 0.4mi-per-ring when the client row predates the radius column.
const RINGS_FROM_CENTER = 4;

export default async function ClientDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = getServerSupabase();

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .maybeSingle<ClientRow>();
  if (!client) notFound();

  const { data: latestScan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();

  // Show the keyword tied to the latest scan if there is one; otherwise fall
  // back to the client's primary keyword so brand-new clients still see what
  // will be tracked.
  const { data: keyword } = latestScan
    ? await supabase
        .from('tracked_keywords')
        .select('*')
        .eq('id', latestScan.keyword_id)
        .maybeSingle<TrackedKeywordRow>()
    : await supabase
        .from('tracked_keywords')
        .select('*')
        .eq('client_id', id)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle<TrackedKeywordRow>();

  const { data: rawPoints } = latestScan
    ? await supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, business_found, competitors')
        .eq('scan_id', latestScan.id)
    : { data: [] as Pick<
        ScanPointRow,
        'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
      >[] };

  const points = rawPoints ?? [];

  // Fetch the most recent AI insight for this scan, if one exists.
  const { data: insightRow } = latestScan
    ? await supabase
        .from('ai_insights')
        .select('diagnosis, actions, projected_impact')
        .eq('scan_id', latestScan.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{
          diagnosis: string;
          actions: AICoachAction[];
          projected_impact: string | null;
        }>()
    : { data: null };

  const cells: HeatmapCell[] = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);
  const score = turfScore(ranks);
  const t3 = top3Rate(ranks);
  const radiusUnits = turfRadius(
    points.map((p) => ({
      point: { x: p.grid_x, y: p.grid_y },
      rank: p.rank,
    })),
    9,
    OUT_OF_PACK_RANK
  );

  // Curated mode: if the agency has explicitly tracked competitor brands for
  // this client (rows in the `competitors` table), surface ALL of them in the
  // sidebar — including ones that never appeared in the local pack — so a
  // sales pitch can show the full competitive landscape.
  // Default mode: dynamically discover the top 3 from raw scan data.
  const { data: trackedCompetitors } = await supabase
    .from('competitors')
    .select('competitor_name')
    .eq('client_id', id);

  const curatedBrandNames = (trackedCompetitors ?? []).map(
    (r) => r.competitor_name as string
  );

  let competitors: Array<{ name: string; amr: number; top3Pct: number }>;
  let isCurated = false;
  if (curatedBrandNames.length > 0) {
    competitors = aggregateCuratedCompetitors(
      points,
      curatedBrandNames,
      points.length || 1
    );
    isCurated = true;
  } else {
    const ownNamePattern = new RegExp(
      client.business_name.split(/\s+/)[0] ?? '',
      'i'
    );
    competitors = aggregateCompetitors(points, points.length || 1, {
      excludeNamePattern: ownNamePattern,
    });
  }

  // Heatmap toggle pills are useful only for competitors that actually appear
  // in some cells (otherwise the toggled view is a blank grid). The right-rail
  // CompetitorTable still gets the full curated list so the deck shows every
  // brand the agency tracks.
  const heatmapCompetitors = isCurated
    ? competitors.filter((c) => (c as { top3Pct: number }).top3Pct > 0)
    : competitors;

  return (
    <div className="min-h-screen w-full text-white">
      <Header />

      {/* Business setup bar */}
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
        <div className="col-span-3 flex flex-col items-end gap-2">
          <div className="text-xs text-zinc-500 font-mono">
            {latestScan ? (
              <>
                Last scan:{' '}
                {new Date(latestScan.completed_at ?? latestScan.created_at!)
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 16)}{' '}
                UTC
              </>
            ) : (
              <>No scans yet</>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/clients/${client.id}/settings`}
              className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-card)',
              }}
            >
              <Settings size={12} /> Settings
            </Link>
            <Link
              href={`/clients/${client.id}/scans`}
              className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-card)',
              }}
            >
              <History size={12} /> History
            </Link>
            {latestScan && (
              <a
                href={`/api/reports/pdf?scanId=${latestScan.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text, white)',
                  background: 'var(--color-card)',
                }}
              >
                <Download size={12} /> PDF
              </a>
            )}
            <ScanButton
              clientId={client.id}
              keywordLabel={keyword?.keyword}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 p-8">
        {/* Heatmap */}
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
                9×9 geo-grid · 81 search points · {client.service_radius_miles ?? 1.6}mi radius · UULE-based
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
            competitors={heatmapCompetitors.map((c): CompetitorView => ({
              ...c,
              cells: buildCompetitorCells(points, c.name),
            }))}
          />
        </div>

        {/* Stats sidebar */}
        <div className="col-span-4 space-y-4">
          <StatCard
            label="TurfScore™"
            value={score === null ? '—' : score.toFixed(1)}
            subtitle="Average Map Rank · lower is better"
            icon={Target}
          />
          <StatCard
            label="3-Pack Win Rate"
            value={latestScan ? `${t3}%` : '—'}
            subtitle="Of 81 grid points where you rank top 3"
            icon={Crown}
            highlight
          />
          <StatCard
            label="TurfRadius™"
            value={
              latestScan
                ? `${(
                    radiusUnits *
                    ((client.service_radius_miles ?? 1.6) / RINGS_FROM_CENTER)
                  ).toFixed(1)}mi`
                : '—'
            }
            subtitle="Distance you maintain top-3 visibility"
            icon={TrendingUp}
          />
          <CompetitorTable competitors={competitors} />
        </div>

        {/* AI Coach — full width below the heatmap + sidebar */}
        <div className="col-span-12">
          <AICoach
            scanId={latestScan?.id ?? null}
            insight={insightRow ?? null}
            scanComplete={Boolean(latestScan)}
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
          {latestScan
            ? `Scan ${latestScan.id.slice(0, 8)} · ${
                latestScan.failed_points ?? 0
              } failed pts · $${(
                (latestScan.dfs_cost_cents ?? 0) / 100
              ).toFixed(2)} DFS`
            : 'Awaiting first scan'}
        </span>
      </footer>
    </div>
  );
}
