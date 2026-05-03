import { notFound } from 'next/navigation';
import Link from 'next/link';

// Always render fresh — the page reads scan_points, which can change on
// every scan. force-dynamic also kills any Next.js Data Cache layer that
// might serve stale Supabase responses after a metric-definition change.
export const dynamic = 'force-dynamic';
import { Compass, Crown, Download, History, MapPin, Settings, Sparkles, Target } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import { listLocations, resolveLocation } from '@/lib/supabase/locations';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank, turfRankCaption } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { aggregateCuratedCompetitors } from '@/lib/metrics/curatedCompetitors';
import { Header } from '@/components/turfmap/Header';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { HeatmapWithToggle, type CompetitorView } from '@/components/turfmap/HeatmapWithToggle';
import { StatCard } from '@/components/turfmap/StatCard';
import { MomentumCard } from '@/components/turfmap/MomentumCard';
import { CompetitorTable } from '@/components/turfmap/CompetitorTable';
import { InfoTooltip } from '@/components/turfmap/InfoTooltip';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import { ScanButton } from '@/components/turfmap/ScanButton';
import { ShareLinkButton } from '@/components/turfmap/ShareLinkButton';
import { LocationSwitcher } from '@/components/turfmap/LocationSwitcher';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';

// Default 9×9 grid is 4 rings out from the center cell, so spacing per ring
// is `service_radius_miles / 4`. Falls back to the v1 default of 1.6mi /
// 0.4mi-per-ring when the client row predates the radius column.
const RINGS_FROM_CENTER = 4;

export default async function ClientDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam } = await searchParams;
  const me = await requireAgencyUserOrRedirect(`/clients/${clientParam}`);
  const supabase = getServerSupabase();

  // Tolerant lookup — accepts the short public_id (default for new URLs)
  // or a legacy UUID (for bookmarks predating migration 0007).
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) notFound();
  const id = client.id; // canonical UUID used for all subsequent queries

  // Multi-location resolution: if `?location=<id>` is in the URL, scope
  // the dashboard to that location; otherwise default to the client's
  // primary location. All scan / keyword / scan_points / ai_insights
  // queries below filter by the resolved location_id.
  const locations = await listLocations(supabase, id);
  const activeLocation =
    (await resolveLocation(supabase, id, locationParam ?? null)) ??
    locations[0] ??
    null;

  const { data: latestScan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', id)
    .eq('status', 'complete')
    .eq('location_id', activeLocation?.id ?? '')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();

  // Show the keyword tied to the latest scan if there is one; otherwise fall
  // back to a primary keyword for the active location (or any keyword on
  // this client if the location has none yet).
  const { data: keyword } = latestScan
    ? await supabase
        .from('tracked_keywords')
        .select('*')
        .eq('id', latestScan.keyword_id)
        .maybeSingle<TrackedKeywordRow>()
    : activeLocation
      ? await (async () => {
          const { data: locKw } = await supabase
            .from('tracked_keywords')
            .select('*')
            .eq('client_id', id)
            .eq('location_id', activeLocation.id)
            .order('is_primary', { ascending: false })
            .limit(1)
            .maybeSingle<TrackedKeywordRow>();
          if (locKw) return { data: locKw };
          // Fallback: any keyword on this client (legacy rows without
          // a location_id, or before this location had its own keywords).
          return await supabase
            .from('tracked_keywords')
            .select('*')
            .eq('client_id', id)
            .order('is_primary', { ascending: false })
            .limit(1)
            .maybeSingle<TrackedKeywordRow>();
        })()
      : { data: null };

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
  // New score family. Reads scans columns when populated (post-backfill);
  // recomputes from scan_points as a defensive fallback so the dashboard
  // never shows stale values during a metric definition transition.
  const reach =
    latestScan?.turf_reach != null
      ? Number(latestScan.turf_reach)
      : turfReach(ranks);
  const rank =
    latestScan?.turf_rank != null
      ? Number(latestScan.turf_rank)
      : turfRank(ranks);
  const score =
    latestScan?.turf_score != null
      ? Number(latestScan.turf_score)
      : composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);
  // Momentum is null until the second scan; the page reads the persisted
  // column rather than recomputing client-side because computing it
  // requires another DB round trip for the prior scan.
  const momentumValue =
    latestScan?.momentum != null ? Number(latestScan.momentum) : null;
  // First-scan banner trigger — rendered when this is the only complete
  // scan in history. Uses scan count rather than `momentum === null`
  // because Momentum can also be null on a failed-prior-scan edge case.
  const { count: completedScanCount } = await supabase
    .from('scans')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', id)
    .eq('location_id', activeLocation?.id ?? '')
    .eq('status', 'complete');
  const isFirstScan = (completedScanCount ?? 0) <= 1;

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
      <Header userEmail={me.email} />

      {latestScan && isFirstScan && (
        <div
          className="px-8 py-3 border-b flex items-center gap-3 text-xs"
          style={{
            background: '#0d130a',
            borderColor: 'var(--color-border)',
            color: '#a1a1aa',
          }}
        >
          <Sparkles size={14} style={{ color: 'var(--color-lime)' }} />
          <span>
            <span className="text-zinc-200 font-semibold">
              Baseline scan complete.
            </span>{' '}
            This is your starting point — re-scans every 90 days will show
            your territory expanding.
          </span>
        </div>
      )}

      {/* Location switcher — only renders for multi-location clients */}
      {locations.length > 1 && (
        <div
          className="border-b px-8 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <LocationSwitcher
            clientId={client.public_id}
            locations={locations}
            activeLocationId={activeLocation?.id ?? null}
          />
        </div>
      )}

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
            {activeLocation && !activeLocation.is_primary && (
              <span className="text-zinc-500 font-normal text-xs ml-1.5">
                · {activeLocation.label || activeLocation.city || 'Location'}
              </span>
            )}
          </div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Pin Location
          </div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200">
            <MapPin size={13} className="text-zinc-500" />
            {activeLocation?.address ?? client.address}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Tracking Keyword
          </div>
          <div className="text-sm font-mono text-zinc-200 truncate">
            {keyword?.keyword ?? '—'}
          </div>
        </div>
        <div className="col-span-4 flex flex-col items-end gap-2">
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
          <div className="flex items-center justify-end gap-2 flex-wrap">
            <Link
              href={`/clients/${client.public_id}/settings`}
              className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700 whitespace-nowrap"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-card)',
              }}
            >
              <Settings size={12} /> Settings
            </Link>
            <Link
              href={`/clients/${client.public_id}/scans`}
              className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700 whitespace-nowrap"
              style={{
                borderColor: 'var(--color-border)',
                background: 'var(--color-card)',
              }}
            >
              <History size={12} /> History
            </Link>
            {latestScan && (
              <>
                <a
                  href={`/api/reports/pdf?scanId=${latestScan.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700 whitespace-nowrap"
                  style={{
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text, white)',
                    background: 'var(--color-card)',
                  }}
                >
                  <Download size={12} /> PDF
                </a>
                <ShareLinkButton scanId={latestScan.id} />
              </>
            )}
            <ScanButton
              clientId={client.public_id}
              locationId={activeLocation?.id ?? null}
              keywordLabel={keyword?.keyword}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 p-8">
        {/* Heatmap */}
        <div
          className="col-span-8 border rounded-lg p-6 relative"
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
              <p className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
                9×9 geo-grid · 81 search points ·{' '}
                {activeLocation?.service_radius_miles ?? client.service_radius_miles ?? 1.6}mi radius · UULE-based
                <InfoTooltip width="w-72">
                  Each of the 81 cells is one Google search executed from a
                  specific GPS coordinate (UULE = Google&rsquo;s URL parameter
                  for &ldquo;simulate this search from this location&rdquo;).
                  Spacing between cells is{' '}
                  {(((activeLocation?.service_radius_miles ?? client.service_radius_miles ?? 1.6)) / RINGS_FROM_CENTER).toFixed(2)}{' '}
                  mi on this grid.
                </InfoTooltip>
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
              {[
                { color: '#c5ff3a', label: '#1' },
                { color: '#e8e54a', label: '#2' },
                { color: '#ff9f3a', label: '#3' },
                { color: '#ff4d4d', label: 'Not in pack' },
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

        {/* Stats sidebar — score family redesign:
              hero TurfScore (full width)
              paired TurfReach + TurfRank (2-up grid)
              optional Momentum (full width, second+ scan only)
        */}
        <div className="col-span-4 space-y-4">
          <StatCard
            variant="hero"
            label="TurfScore™"
            value={latestScan ? `${score} / 100` : '—'}
            subtitle="Composite visibility score"
            icon={Target}
            highlight
            band={latestScan ? { label: band.label, tone: band.tone } : undefined}
            tooltip={
              <>
                Your composite visibility score, 0 to 100. Combines how
                much of your territory you cover (TurfReach) with how
                high you rank when you appear (TurfRank). Benchmarks:
                0&ndash;20 invisible, 20&ndash;40 patchy, 40&ndash;60
                solid, 60&ndash;80 dominant, 80+ rare air.
              </>
            }
          />
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label="TurfReach™"
              value={latestScan ? `${reach}%` : '—'}
              subtitle={
                latestScan
                  ? `Visible in ${reach}% of your territory`
                  : 'Coverage of your territory'
              }
              icon={Compass}
              tooltip={
                <>
                  The percentage of your service area where you appear
                  in Google&rsquo;s local 3-pack. Measured across an
                  81-point grid covering your territory.
                </>
              }
            />
            <StatCard
              label="TurfRank™"
              value={
                latestScan && rank !== null ? `${rank.toFixed(1)} / 3` : '—'
              }
              subtitle={turfRankCaption(rank)}
              icon={Crown}
              tooltip={
                <>
                  Your average position in the local 3-pack across the
                  cells where you appear. 3.0 = always #1, 2.0 = always
                  #2, 1.0 = always #3. Higher is better.
                </>
              }
            />
          </div>
          {latestScan && !isFirstScan && (
            <MomentumCard momentum={momentumValue} />
          )}
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
        <span className="flex items-center gap-2.5">
          TurfMap™ is proprietary technology of
          <a
            href="https://fourdots.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center hover:opacity-100 transition-opacity opacity-60"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fourdots-logo.png"
              alt="Fourdots Digital"
              className="h-4 w-auto"
            />
          </a>
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
