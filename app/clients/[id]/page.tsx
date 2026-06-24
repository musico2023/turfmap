import { notFound } from 'next/navigation';
import Link from 'next/link';

// Always render fresh — the page reads scan_points, which can change on
// every scan. force-dynamic also kills any Next.js Data Cache layer that
// might serve stale Supabase responses after a metric-definition change.
export const dynamic = 'force-dynamic';
import { Compass, Crown, Download, History, MapPin, Settings, Sparkles, Target } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  listLocations,
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import type {
  CitationOrderRow,
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
import { KeywordSwitcher } from '@/components/turfmap/KeywordSwitcher';
import { ClientBrandMark } from '@/components/turfmap/ClientBrandMark';
import { InternalsFooter } from '@/components/turfmap/InternalsFooter';
import { LinkButton } from '@/components/ui/Button';
import { buttonStyles } from '@/components/ui/buttonStyles';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { CitationsPanel } from '@/components/turfmap/CitationsPanel';
import { GbpScorecardCard } from '@/components/turfmap/GbpScorecardCard';
import { CompetitorIntelCard } from '@/components/turfmap/CompetitorIntelCard';
import { KeywordOpportunityCard } from '@/components/turfmap/KeywordOpportunityCard';
import { getLatestSignals } from '@/lib/google/enrich';
import { scoreGbpProfile } from '@/lib/metrics/gbpScore';
import { computeCompetitorIntel } from '@/lib/metrics/competitorIntel';
import { rankKeywordOpportunities } from '@/lib/metrics/keywordOpportunity';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';
import { getRescanCapStatus, shouldBypassRescanCap } from '@/lib/scans/rateLimit';
import { canAccessCitations, resolveTier } from '@/lib/subscription/tier';

// Default 9×9 grid is 4 rings out from the center cell, so spacing per ring
// is `service_radius_miles / 4`. Falls back to the v1 default of 1.6mi /
// 0.4mi-per-ring when the client row predates the radius column.
const RINGS_FROM_CENTER = 4;

export default async function ClientDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string; keyword?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam, keyword: keywordParam } = await searchParams;
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

  // Per-location keyword list — drives the KeywordSwitcher and lets us
  // resolve which keyword's scan to show. Each (location, keyword) pair
  // has its own scan history; the dashboard only renders one at a time.
  const { data: locationKeywords } = activeLocation
    ? await supabase
        .from('tracked_keywords')
        .select('id, keyword, is_primary')
        .eq('client_id', id)
        .eq('location_id', activeLocation.id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .returns<
          Pick<TrackedKeywordRow, 'id' | 'keyword' | 'is_primary'>[]
        >()
    : { data: null };
  const keywordList = locationKeywords ?? [];

  // Resolve the active keyword:
  //   1. ?keyword=<id> if present and matches a keyword on this location
  //   2. The location's primary keyword
  //   3. The first keyword on the location
  //   4. A LEGACY keyword (location_id IS NULL) — pre-multi-location
  //      migration rows that haven't been re-scoped yet
  //
  // We deliberately do NOT fall back to a sibling location's keyword
  // here. Pre-fix, a multi-location client with one location lacking
  // a keyword would silently surface another location's keyword as
  // the "active" one, and the ScanButton would happily fire a scan
  // against the wrong (location, keyword) pair — yielding nonsense
  // results (the Sugar Daddy Doughnuts Union Station bug). Now an
  // unscoped location stays empty until the operator explicitly
  // adds a keyword for it, and the ScanButton renders disabled with
  // a clear "add a keyword" affordance.
  let activeKeyword:
    | Pick<TrackedKeywordRow, 'id' | 'keyword' | 'is_primary'>
    | null = null;
  if (keywordParam) {
    activeKeyword =
      keywordList.find((k) => k.id === keywordParam) ?? null;
  }
  if (!activeKeyword) {
    activeKeyword =
      keywordList.find((k) => k.is_primary) ?? keywordList[0] ?? null;
  }
  if (!activeKeyword) {
    // Legacy fallback — only keywords with location_id IS NULL.
    // Modern data has location_id stamped, so this only matches the
    // brief migration window between client-create and the
    // location_id stamp on the primary keyword.
    const { data: anyKw } = await supabase
      .from('tracked_keywords')
      .select('id, keyword, is_primary')
      .eq('client_id', id)
      .is('location_id', null)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword' | 'is_primary'>>();
    activeKeyword = anyKw ?? null;
  }

  // Latest scan for this (location, keyword) pair specifically.
  const { data: latestScan } = activeKeyword
    ? await supabase
        .from('scans')
        .select('*')
        .eq('client_id', id)
        .eq('status', 'complete')
        .eq('location_id', activeLocation?.id ?? '')
        .eq('keyword_id', activeKeyword.id)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle<ScanRow>()
    : { data: null };

  // Full keyword row tied to the displayed scan — already resolved above
  // since the latest scan was queried by activeKeyword.id.
  const keyword = activeKeyword;

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

  // Rescan cap status — disables the Re-scan turf button when this
  // location has hit 3 on-demand scans in the last 24h. Server-fetched
  // here so the button can render its disabled state without a round-
  // trip; the trigger route also enforces the cap defensively.
  //
  // Owner bypass: skip the prefetch entirely for staff in the bypass
  // set so the button never reads as disabled. ScanButton treats null
  // rescanCap as "no rate-limit display" (per its prop doc).
  const rescanCap =
    activeLocation && !shouldBypassRescanCap(me.email)
      ? await getRescanCapStatus(supabase, activeLocation.id)
      : null;

  // Citations panel state. Fetch the open (non-paused, non-failed)
  // citation order for this (client, location). Null when no order
  // exists yet — panel renders the "Set up citations" CTA in that
  // case. Pulse+ only — citations are part of the Pulse+ feature set
  // (managed citation building is a premium-tier deliverable). Pulse
  // and one_time clients don't see the panel.
  const tierForGating = resolveTier(client);
  const showCitationsPanel = canAccessCitations(tierForGating);
  const { data: citationOrder } =
    showCitationsPanel && activeLocation
      ? await supabase
          .from('citation_orders')
          .select('*')
          .eq('client_id', id)
          .eq('location_id', activeLocation.id)
          .eq('maintenance_paused', false)
          .neq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<CitationOrderRow>()
      : { data: null };

  // GBP Optimization Scorecard — Pulse+ feature. Score the latest captured
  // Google Business Profile signals (gbp_signals) into a 0–100 completeness
  // score + per-dimension gaps so the dashboard surfaces concrete GBP actions
  // (the lever the AI Coach leads with for reach-bound businesses). Gated to
  // the same Pulse+ tier as the citations panel.
  const gbpSignals =
    showCitationsPanel && activeLocation
      ? await getLatestSignals(supabase, activeLocation.id)
      : null;
  const gbpScore = gbpSignals
    ? scoreGbpProfile({
        rating: gbpSignals.rating,
        reviewCount: gbpSignals.user_ratings_total,
        primaryType: gbpSignals.primary_type,
        types: gbpSignals.types,
        businessStatus: gbpSignals.business_status,
        photosCount: gbpSignals.photos_count,
        hoursSummary:
          (gbpSignals.regular_opening_hours as { weekdayDescriptions?: string[] } | null)
            ?.weekdayDescriptions ?? null,
      })
    : null;

  // Competitors: automatic discovery by default; per-location manual
  // override when the operator has explicitly added competitors via the
  // settings → Tracked competitors card. The query is strictly scoped
  // to the active location (no client-wide fallback) so legacy seed-
  // script rows pinned to the primary don't auto-trigger curated mode
  // on sibling locations.
  //
  // Empty list → automatic mode (aggregateCompetitors discovers from
  //                              the scan's observed local-pack brands).
  // Non-empty   → curated mode (aggregateCuratedCompetitors looks up
  //                              the operator-specified brands and
  //                              surfaces them all, even at 0% share —
  //                              the CompetitorTable's expander hides
  //                              the absent ones below the fold).
  const { data: locationCurated } = activeLocation
    ? await supabase
        .from('competitors')
        .select('competitor_name')
        .eq('client_id', id)
        .eq('location_id', activeLocation.id)
    : { data: null };
  const curatedNames = (locationCurated ?? []).map(
    (r) => r.competitor_name as string
  );
  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const isCurated = curatedNames.length > 0;
  const competitors = isCurated
    ? aggregateCuratedCompetitors(points, curatedNames, points.length || 1)
    : aggregateCompetitors(points, points.length || 1, {
        excludeNamePattern: ownNamePattern,
      });
  // Heatmap toggle: only show competitors actually in some cells —
  // toggling to a 0%-share competitor renders an empty grid which
  // looks broken. CompetitorTable still receives the full list so the
  // expander surfaces the absent rows.
  const heatmapCompetitors = isCurated
    ? competitors.filter((c) => (c as { top3Pct: number }).top3Pct > 0)
    : competitors;

  // Competitor Intel card — Pulse+ only. Reuses the already-loaded scan
  // points + the client's own GBP signals to surface the top rivals by
  // grid share with their reviews/rating gaps (the prominence levers the
  // AI Coach leads with). Null when no competitor holds meaningful share.
  const competitorIntel = showCitationsPanel
    ? computeCompetitorIntel({
        points: points.map((p) => ({ rank: p.rank ?? null, competitors: p.competitors })),
        own: {
          name: client.business_name,
          rating: gbpSignals?.rating ?? null,
          reviews: gbpSignals?.user_ratings_total ?? null,
        },
      })
    : null;

  // Keyword Opportunity Finder — Pulse+ only. One latest-scan lookup per
  // tracked keyword (capped, mirrors the AI Coach's cross-keyword section),
  // ranking which keyword is most winnable. Only when the location tracks
  // more than one keyword — there's nothing to compare otherwise. (We don't
  // surface per-cell "striking distance": the Local Pack scan only returns
  // pack positions, so ranks below the 3-pack are unmeasured.)
  const keywordOpportunity =
    showCitationsPanel && activeLocation && keywordList.length > 1
      ? await (async () => {
          const perf = await Promise.all(
            keywordList.slice(0, 8).map(async (kw) => {
              const { data: latest } = await supabase
                .from('scans')
                .select('turf_score, turf_reach, turf_rank')
                .eq('location_id', activeLocation.id)
                .eq('keyword_id', kw.id)
                .eq('status', 'complete')
                .order('completed_at', { ascending: false })
                .limit(1)
                .maybeSingle<{
                  turf_score: number | null;
                  turf_reach: number | null;
                  turf_rank: number | null;
                }>();
              return {
                keyword: kw.keyword,
                isPrimary: Boolean(kw.is_primary),
                turfScore: latest?.turf_score != null ? Number(latest.turf_score) : null,
                turfReach: latest?.turf_reach ?? null,
                turfRank: latest?.turf_rank != null ? Number(latest.turf_rank) : null,
              };
            })
          );
          return rankKeywordOpportunities(perf);
        })()
      : null;

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      {latestScan && isFirstScan && (
        <div
          className="px-4 md:px-8 py-3 border-b flex items-center gap-3 text-xs"
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
            This is the starting point — visibility expands as scans
            re-run and the AI Coach playbook is acted on.
          </span>
        </div>
      )}

      {/* Location + keyword switchers — share one strip. KeywordSwitcher
          always renders (as a non-interactive pill when there's a
          single keyword, as a dropdown when there are multiple) so the
          active keyword is always visible at the top of the page.
          LocationSwitcher self-hides when there's ≤ 1 location. The
          strip mounts whenever there's at least one keyword to show
          (i.e. always for any real client). */}
      {keywordList.length > 0 && (
        <div
          className="border-b px-4 md:px-8 py-3 flex items-center gap-3 md:gap-6 flex-wrap"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <LocationSwitcher
            clientId={client.public_id}
            locations={locations}
            activeLocationId={activeLocation?.id ?? null}
          />
          <KeywordSwitcher
            clientId={client.public_id}
            keywords={keywordList}
            activeKeywordId={activeKeyword?.id ?? null}
          />
        </div>
      )}

      {/* Business setup bar — stacks on mobile, four columns at lg+ */}
      <div
        className="border-b px-4 md:px-8 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 md:gap-4 items-start lg:items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="lg:col-span-3 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Business
          </div>
          <div className="flex items-center gap-2.5">
            <ClientBrandMark
              logoUrl={client.logo_url}
              businessName={client.business_name}
              size={28}
            />
            <div className="text-sm font-medium text-zinc-100 min-w-0">
              <span className="truncate block">
                {client.business_name}
                {activeLocation && !activeLocation.is_primary && (
                  <span className="text-zinc-500 font-normal text-xs ml-1.5">
                    · {activeLocation.label || activeLocation.city || 'Location'}
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="lg:col-span-4 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Pin Location
          </div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200">
            <MapPin size={13} className="text-zinc-500 flex-shrink-0" />
            <span className="truncate">
              {activeLocation?.address ?? client.address}
            </span>
          </div>
        </div>
        {/* "Tracking Keyword" column removed — the active keyword is
         *  now surfaced in the switcher strip above the business bar
         *  (KeywordSwitcher renders a static pill for single-keyword
         *  clients), so showing it again here was redundant. */}
        <div className="lg:col-span-5 flex flex-col sm:items-start lg:items-end gap-2">
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
            <LinkButton
              variant="secondary"
              size="md"
              href={`/clients/${client.public_id}/settings`}
              leftIcon={<Settings size={12} />}
            >
              Settings
            </LinkButton>
            <LinkButton
              variant="secondary"
              size="md"
              href={`/clients/${client.public_id}/scans`}
              leftIcon={<History size={12} />}
            >
              History
            </LinkButton>
            {latestScan && (
              <>
                <a
                  href={`/api/reports/pdf?scanId=${latestScan.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...buttonStyles({ variant: 'secondary', size: 'md' })}
                >
                  <Download size={12} /> PDF
                </a>
                <ShareLinkButton scanId={latestScan.id} />
              </>
            )}
            <ScanButton
              clientId={client.public_id}
              clientPublicId={client.public_id}
              locationId={activeLocation?.id ?? null}
              keywordId={activeKeyword?.id ?? null}
              keywordLabel={latestScan ? keyword?.keyword : undefined}
              rescanCap={rescanCap}
              hasKeyword={keywordList.length > 0}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 p-4 md:p-8">
        {/* Heatmap */}
        <div
          className="lg:col-span-8 border rounded-lg p-4 md:p-6 relative"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
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
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider flex-wrap">
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
        <div className="lg:col-span-4 space-y-4">
          {/* Attribution eyebrow — same as portal/share. Keeps the
              score family tied to the account holder visually, even
              when the heatmap above is toggled to a competitor view. */}
          <div
            className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5 flex-wrap"
            aria-label="Score attribution"
          >
            <span>Visibility for</span>
            <span className="text-zinc-200 normal-case tracking-normal font-bold">
              {client.business_name}
            </span>
          </div>
          <StatCard
            variant="hero"
            label="TurfScore™"
            value={latestScan ? `${score} / 100` : '—'}
            subtitle="Composite visibility score"
            icon={Target}
            highlight
            fillPct={latestScan ? score : null}
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
        <div className="lg:col-span-12">
          <AICoach
            scanId={latestScan?.id ?? null}
            insight={insightRow ?? null}
            scanComplete={Boolean(latestScan)}
            allowRegenerate
          />
        </div>

        {/* GBP Optimization Scorecard — Pulse+ only. Renders nothing when
         *  there are no GBP signals captured yet for the active location. */}
        {gbpScore && (
          <div className="lg:col-span-12">
            <GbpScorecardCard result={gbpScore} />
          </div>
        )}

        {/* Keyword Opportunity Finder — Pulse+ only. A cross-keyword focus
         *  ranking; renders only when the location tracks >1 keyword. */}
        {keywordOpportunity && (
          <div className="lg:col-span-12">
            <KeywordOpportunityCard result={keywordOpportunity} />
          </div>
        )}

        {/* Competitor Intel — Pulse+ only. Hidden when no rival holds
         *  meaningful grid share on this keyword. */}
        {competitorIntel && (
          <div className="lg:col-span-12">
            <CompetitorIntelCard result={competitorIntel} />
          </div>
        )}

        {/* Citations panel — Pulse+ / agency-managed clients only.
         *  When no citation order exists yet, the panel surfaces a
         *  "Set up citations" CTA pointing at the onboarding form. */}
        {showCitationsPanel && (
          <div className="lg:col-span-12">
            <CitationsPanel
              order={citationOrder ?? null}
              clientPublicId={client.public_id}
              locationId={activeLocation.id}
              locationLabel={locationDisplayLabel(activeLocation)}
            />
          </div>
        )}
      </div>

      <footer
        className="border-t px-4 md:px-8 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-3 text-xs text-zinc-600"
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
        {latestScan ? (
          <InternalsFooter
            scanId={latestScan.id}
            failedPoints={latestScan.failed_points ?? 0}
            dfsCostCents={latestScan.dfs_cost_cents ?? 0}
          />
        ) : (
          <span className="font-mono text-zinc-700">Awaiting first scan</span>
        )}
      </footer>
    </div>
  );
}
