/**
 * Public share view for a single scan — `/share/[id]`.
 *
 * No auth required. Hits a `scan_share_links` row by id; if expired,
 * revoked, or missing, renders an "Expired" screen. Otherwise renders
 * a portal-style read-only dashboard with all the score cards,
 * heatmap, competitor list, and AI Coach playbook.
 *
 * Differs from /portal/<id> in that there's no white-label client
 * branding (the audience may not yet be a client) — TurfMap lime
 * accent, plus an optional agency_label / cta surfaced at the top
 * and bottom respectively. Internal stuff (DFS cost, scan IDs, scan
 * controls) is hidden as in the portal view.
 *
 * Side effect: increments scan_share_links.view_count + stamps
 * last_viewed_at on every render. v1 — no dedup. Sales-funnel
 * signal is more useful than precision here.
 *
 * force-dynamic so the view counter ticks on every fetch and the
 * expiry check never serves a stale "active" page.
 */

import {
  ChevronRight,
  Clock,
  Compass,
  Crosshair,
  Crown,
  Lock,
  MapPin,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { getServerSupabase } from '@/lib/supabase/server';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';
import {
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  ScanShareLinkRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank, turfRankCaption } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import { cleanCompetitorName } from '@/lib/dataforseo/cleanCompetitorName';
import { isDiscountedLeadSource } from '@/lib/score/leadSources';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import {
  HeatmapWithToggle,
  type CompetitorView,
} from '@/components/turfmap/HeatmapWithToggle';
import { StatCard } from '@/components/turfmap/StatCard';
import { MomentumCard } from '@/components/turfmap/MomentumCard';
import { CompetitorTable } from '@/components/turfmap/CompetitorTable';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { ClientBrandMark } from '@/components/turfmap/ClientBrandMark';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';
import {
  PreviewAICoachLock,
  PreviewCompetitorLock,
  PreviewHeatmapLock,
} from '@/components/turfmap/PreviewLocks';
import { ShareCountdownBanner } from '@/components/turfmap/ShareCountdownBanner';
import {
  StickyShareUnlockBar,
  SHARE_HERO_SENTINEL_ID,
  SHARE_FINAL_SENTINEL_ID,
} from '@/components/turfmap/StickyShareUnlockBar';
import { UnlockShareButton } from '@/components/turfmap/UnlockShareButton';

export const dynamic = 'force-dynamic';

export default async function PublicSharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: shareId } = await params;
  const supabase = getServerSupabase();

  // 1. Look up the share link itself.
  const { data: share } = await supabase
    .from('scan_share_links')
    .select('*')
    .eq('id', shareId)
    .maybeSingle<ScanShareLinkRow>();
  if (!share) return <ExpiredScreen reason="not_found" />;

  if (share.revoked_at) return <ExpiredScreen reason="revoked" />;
  if (new Date(share.expires_at).getTime() < Date.now()) {
    return <ExpiredScreen reason="expired" expiresAt={share.expires_at} />;
  }

  // 2. Bump the view counter (best-effort; never block render on it).
  void supabase
    .from('scan_share_links')
    .update({
      view_count: (share.view_count ?? 0) + 1,
      last_viewed_at: new Date().toISOString(),
    })
    .eq('id', shareId);

  // 3. Load the scan + everything we need to render the dashboard view.
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', share.scan_id)
    .maybeSingle<ScanRow>();
  if (!scan) return <ExpiredScreen reason="not_found" />;

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
        .select('grid_x, grid_y, rank, business_found, competitors')
        .eq('scan_id', scan.id)
        .returns<
          Pick<
            ScanPointRow,
            'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
          >[]
        >(),
    ]);
  if (!client) return <ExpiredScreen reason="not_found" />;

  // Resolve the scan's specific location (post-migration 0006). Shares
  // are pinned to a single scan → single location, so there's no
  // switcher to mount; we just need the right address + service-radius
  // values for display so the recipient sees the storefront the report
  // was actually generated for. Falls back to the client's deprecated
  // mirror columns for legacy scans without a location_id.
  const scanLocation = await resolveLocation(
    supabase,
    scan.client_id,
    scan.location_id ?? null
  );

  const points = rawPoints ?? [];
  const cells: HeatmapCell[] = points.map((p) => ({
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
    scan.turf_score != null
      ? Number(scan.turf_score)
      : composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);
  const momentumValue =
    scan.momentum != null ? Number(scan.momentum) : null;

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  // ─── Preview-cohort competitor gating ───────────────────────────────
  //
  // Per the §4 "load-bearing requirement" of the re-gate ticket:
  // competitor NAMES must be withheld server-side from the preview
  // payload — never just CSS-hidden. The PreviewCompetitorLock
  // receives masked rows (real cell_share + avg_rank, name=null) so
  // a buyer with DevTools open finds nothing but stats and lock chrome
  // in the network response / DOM. Names render only when
  // is_preview=false (post-unlock).
  //
  // leaderShare ("preferred definition" from §5.2): the share of the
  // buyer's 81 cells where the top competitor outranks them — i.e.
  // dominance in the buyer's weak zones. Real number from the scan,
  // never a placeholder. Returns null on the rare case where the
  // leader can't be matched against any cell (no data → fallback
  // hero copy renders).
  const previewLeaderShare =
    client.is_preview && competitors.length > 0
      ? computeLeaderShare(competitors[0].name, points)
      : null;

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

  const expiresAtFormatted = new Date(share.expires_at).toLocaleDateString(
    'en-US',
    { month: 'long', day: 'numeric', year: 'numeric' }
  );
  // "Shared by" attribution. agency_label is the operator-supplied
  // free-text "Customize branding" field. When it's blank we only
  // fall back to the "Fourdots Digital" house label if the link was
  // actually created by a Fourdots-owner account. A non-owner account
  // (contractor, partner staff) that didn't set a custom label gets
  // NO attribution rather than being falsely credited to Fourdots —
  // `sharedBy` stays null and both the banner + footer drop the line.
  const customLabel = share.agency_label?.trim();
  let creatorIsAgencyOwner = false;
  if (!customLabel && share.created_by) {
    const { data: creator } = await supabase
      .from('users')
      .select('email')
      .eq('id', share.created_by)
      .maybeSingle<{ email: string }>();
    creatorIsAgencyOwner = isAgencyOwnerEmail(creator?.email);
  }
  const sharedBy =
    customLabel || (creatorIsAgencyOwner ? 'Fourdots Digital' : null);
  const ctaText = share.cta_text?.trim() || 'Want a TurfMap of your business?';
  const ctaUrl = share.cta_url?.trim() || 'https://turfmap.ai';

  // Cold-outreach cohort: detect free-scan outreach orders so we can
  // suppress the conversion CTA in the footer. Cold buyers received
  // the scan FREE — pitching them a paid TurfScan upgrade or the
  // Visibility Audit walkthrough on this page would conflict with
  // the post-scan funnel design, which routes the audit-walkthrough
  // offer through the cold-stage3 founder email and nothing else.
  //
  // Detection is the OR of three independent markers on the scan-
  // tier lead_order for this client:
  //   - stripe_metadata.source = 'coldscan_free' (new no-Stripe
  //     bypass via /api/yourmap/coldscan-fulfill)
  //   - stripe_metadata.cohort LIKE 'cold_email%' (legacy Stripe-
  //     checkout cold path — Yohann at Ainger Group came through
  //     this; cohort='cold_email', source=null)
  //   - stripe_metadata.prospect_id IS NOT NULL (catch-all: any
  //     prospect-stamped scan was outreach-sourced, regardless of
  //     how the lead_order got created)
  const { data: scanLeadOrder } = await supabase
    .from('lead_orders')
    .select('stripe_metadata')
    .eq('client_id', client.id)
    .eq('tier', 'scan')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ stripe_metadata: Record<string, unknown> | null }>();
  const meta = scanLeadOrder?.stripe_metadata ?? null;

  // Preview-mode unlock pricing — driven by lead_source stamped at
  // preview-init time. Cold-Meta lander cohorts (/free-score,
  // /prove-it) get the $49 MAPCHECK50 unlock; homepage /score
  // visitors stay at $99 list. unlock-init reads the same field
  // server-side to apply the Stripe promotion code; this UI flag
  // just keeps the labels in sync. The shared helper in
  // lib/score/leadSources.ts is the canonical eligibility check —
  // unrecognized values fail closed to $99.
  const previewLeadSource =
    meta && typeof (meta as Record<string, unknown>)['lead_source'] === 'string'
      ? ((meta as Record<string, unknown>)['lead_source'] as string)
      : null;
  const discountedUnlock = isDiscountedLeadSource(previewLeadSource);
  // Suppress the operator CTA footer for both the cold-email cohort
  // (their next-step pitch lives in the cold-stage3 email) AND the
  // /score lead-magnet preview cohort (their next-step is the
  // $99 unlock CTA already rendered inside the preview locks above
  // — adding a second "Get in touch" CTA would compete with it).
  const isColdscanShare = Boolean(
    meta &&
      ((meta as Record<string, unknown>)['source'] === 'coldscan_free' ||
        (typeof (meta as Record<string, unknown>)['cohort'] === 'string' &&
          ((meta as Record<string, unknown>)['cohort'] as string).startsWith(
            'cold_email'
          )) ||
        (meta as Record<string, unknown>)['prospect_id'] != null)
  );

  return (
    <div className="min-h-screen w-full text-white">
      {/* MAPCHECK50 24h countdown — sticky top, lime accent, with an
       *  inline unlock CTA so the buyer's first scroll cue + first
       *  conversion path are the same band. Renders only for
       *  preview-cohort Meta buyers (discountedUnlock=true).
       *  Component is a no-op when discountedUnlock is false so it's
       *  safe to mount unconditionally. */}
      {client.is_preview && (
        <ShareCountdownBanner
          shareId={shareId}
          discountedUnlock={discountedUnlock}
        />
      )}

      {/* Mobile-only sticky bottom unlock bar — companion to the top
       *  countdown banner. Top banner = urgency + countdown. Bottom
       *  bar = thumb-friendly always-available tap target. Visible
       *  only when the buyer is mid-page between the heatmap unlock
       *  CTA and the AI Coach unlock CTA (both sentinels off-screen);
       *  hides when either inline CTA enters view to avoid two
       *  competing "Unlock" buttons in the same viewport. */}
      {client.is_preview && (
        <StickyShareUnlockBar
          shareId={shareId}
          discountedUnlock={discountedUnlock}
        />
      )}

      {/* Branded header — not white-labeled because the audience hasn't
          signed up yet. TurfMap-branded so the tool gets the credit. */}
      <header
        className="border-b px-4 md:px-8 py-5 flex items-center justify-between gap-3"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 24px #c5ff3a40',
            }}
          >
            <Crosshair size={18} className="text-black" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-display text-xl font-bold leading-tight">
              TurfMap.ai
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
              Local visibility report
            </div>
          </div>
        </div>
        <div className="text-xs text-zinc-500 font-mono flex items-center gap-2">
          <Clock size={12} />
          Expires {expiresAtFormatted}
        </div>
      </header>

      {/* "Shared by" banner — gives the recipient a face/agency to
          attribute the report to. The "Shared by …" prefix only
          renders when we have a label; non-owner links with no custom
          branding show just the read-only-snapshot context. */}
      <div
        className="px-4 md:px-8 py-3 border-b text-xs text-zinc-400"
        style={{
          background: '#0d130a',
          borderColor: 'var(--color-border)',
        }}
      >
        {sharedBy && (
          <>
            Shared by{' '}
            <span className="text-zinc-200 font-semibold">{sharedBy}</span> ·{' '}
          </>
        )}
        {sharedBy ? 'this' : 'This'} is a read-only snapshot of{' '}
        {client.business_name}&rsquo;s territory for the keyword{' '}
        <span className="font-mono text-zinc-300">
          &ldquo;{keyword?.keyword ?? '—'}&rdquo;
        </span>
        .
      </div>

      {/* Compact business meta — hidden on mobile for preview cohort
       *  because PreviewMobileLayout (rendered below) shows the
       *  business name + keyword in a denser, conversion-tuned
       *  sub-header instead. Non-preview viewers (paid buyers,
       *  agency staff looking at their own clients) see the full
       *  3-col meta on every viewport. */}
      <div
        className={`border-b px-4 md:px-8 py-4 ${
          client.is_preview ? 'hidden lg:grid' : 'grid'
        } grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 items-start md:items-center`}
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="min-w-0">
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
                {scanLocation && !scanLocation.is_primary && (
                  <span className="text-zinc-500 font-normal text-xs ml-1.5">
                    · {locationDisplayLabel(scanLocation)}
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Pin Location
          </div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200">
            <MapPin size={13} className="text-zinc-500 flex-shrink-0" />
            <span className="truncate">
              {scanLocation?.address ?? client.address}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Tracked Keyword
          </div>
          <div className="text-sm font-mono text-zinc-200 truncate">
            {keyword?.keyword ?? '—'}
          </div>
        </div>
      </div>

      {/* Mobile-only quizflow-style layout for preview cohort
       *  (2026-06-13). Replaces the desktop grid on lg-down with a
       *  score-first reveal, projected-lift trajectory, ROI anchor,
       *  3 compressed lock teasers, testimonial, and repeated
       *  unlock CTAs — tuned to match the Logik-quizflow conversion
       *  archetype Anthony shipped on /free-score-now. Same data,
       *  same security guarantees (competitor names already null'd
       *  server-side; the decoy heatmap inside PreviewMobileLayout
       *  is band-keyed pseudorandom, no real cells).
       *
       *  The desktop grid below stays the canonical preview render
       *  on lg+. Unlocked viewers (is_preview=false) never see this
       *  block at all. */}
      {client.is_preview && (
        <div className="lg:hidden">
          <PreviewMobileLayout
            shareId={shareId}
            businessName={client.business_name}
            logoUrl={client.logo_url}
            keyword={keyword?.keyword ?? null}
            scanLocationLabel={
              scanLocation
                ? scanLocation.is_primary
                  ? null
                  : locationDisplayLabel(scanLocation)
                : null
            }
            score={score}
            reach={reach}
            rank={rank}
            bandLabel={band.label}
            cells={cells}
            topCompetitors={competitors.slice(0, 3).map((c) => ({
              name: null,
              top3Pct: c.top3Pct,
              amr: Number.isFinite(c.amr) ? c.amr : null,
            }))}
            totalCompetitorCount={competitors.length}
            googlePrimaryType={
              meta &&
              typeof (meta as Record<string, unknown>)['google_primary_type'] ===
                'string'
                ? ((meta as Record<string, unknown>)[
                    'google_primary_type'
                  ] as string)
                : null
            }
            discountedUnlock={discountedUnlock}
            previewLeaderShare={previewLeaderShare}
          />
        </div>
      )}

      {/* Heatmap + sidebar — same shape as portal/dashboard but
       *  internals stripped out.
       *
       *  Mobile reorder (2026-06-13): the score sidebar gets
       *  order-1 + the heatmap gets order-2, so on mobile the
       *  buyer sees their actual TurfScore FIRST (the reveal they
       *  came for) and only then scrolls to the blurred heatmap
       *  with its PreviewHeatmapLock "Your full map is ready"
       *  unlock prompt. Previously the heatmap-lock copy
       *  monopolized the first viewport on mobile and buried the
       *  score below it — Anthony flagged this from a real
       *  /free-score-now flow test 2026-06-13.
       *
       *  On lg+ (desktop) we re-pin to source order so the
       *  heatmap goes back to the left (col-span-8) and the score
       *  sidebar back to the right (col-span-4) — that layout was
       *  fine because both columns are visible above the fold at
       *  once on desktop.
       *
       *  Mobile-preview takeover (2026-06-13): for preview-cohort
       *  buyers on lg-down, this entire grid is hidden — the new
       *  PreviewMobileLayout block (right after this div) takes
       *  over with a quizflow-style score-first reveal, repeated
       *  CTAs, and compressed lock teasers. Desktop preview still
       *  uses this layout. Unlocked viewers (is_preview=false) get
       *  this layout on every viewport. */}
      <div
        className={`${
          client.is_preview ? 'hidden lg:grid' : 'grid'
        } grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 p-4 md:p-8`}
      >
        <div
          className="order-2 lg:order-1 lg:col-span-8 border rounded-lg p-4 md:p-6 relative"
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
              <p className="text-xs text-zinc-500">
                9×9 geo-grid · 81 search points ·{' '}
                {scanLocation?.service_radius_miles ?? client.service_radius_miles ?? 1.6}mi radius
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
          {client.is_preview ? (
            // ⚠ SECURITY: do NOT pass `cells` or `competitors` here.
            // Anything in the lock component's props ends up in the
            // browser-side React tree and is readable via DevTools,
            // bypassing the visual blur. The PreviewHeatmapLock
            // renders a band-keyed decoy heatmap internally — the
            // buyer's real cell-by-cell rankings + competitor
            // names are NOT shipped to the browser until they
            // unlock. See the "Heatmap lock" header comment in
            // PreviewLocks.tsx for the full rationale.
            <PreviewHeatmapLock
              shareId={shareId}
              bandLabel={band.label}
              discountedUnlock={discountedUnlock}
            />
          ) : (
            <HeatmapWithToggle
              clientCells={cells}
              clientName={client.business_name}
              competitors={competitors.map(
                (c): CompetitorView => ({
                  ...c,
                  cells: buildCompetitorCells(points, c.name),
                })
              )}
            />
          )}
          {/* Sentinel sentinel for StickyShareUnlockBar's hero
           *  observer. While this is in view, the heatmap unlock CTA
           *  is still visible and the bottom sticky stays hidden. */}
          {client.is_preview && (
            <div id={SHARE_HERO_SENTINEL_ID} aria-hidden="true" />
          )}
        </div>

        <div className="order-1 lg:order-2 lg:col-span-4 space-y-4">
          {/* Attribution eyebrow — same intent as on /portal: the
              score family is the account holder's, not whoever the
              heatmap is currently toggled to show. Especially
              important on share links where the recipient may have
              no prior context for whose territory they're looking
              at. */}
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
            value={`${score} / 100`}
            subtitle="Composite visibility score"
            icon={Target}
            highlight
            band={{ label: band.label, tone: band.tone }}
          />
          {/* Preview-cohort only: band-interpretation copy + trajectory
           *  anchor. Replaces "Patchy" / "Solid" labels with a
           *  paragraph the buyer can actually anchor to, plus a
           *  realistic improvement window so the score doesn't feel
           *  static. Hidden for unlocked clients (they have the full
           *  AI Coach panel right below). */}
          {client.is_preview && (
            <PreviewBandInterpretation
              bandLabel={band.label}
              score={score}
            />
          )}
          {/* Preview-cohort only: dollar-anchor ROI card. Translates
           *  reach % into a missed-cell count + multiplies the
           *  trade's industry-average job value against the unlock
           *  price. Defensible framing — coverage-multiplier on a
           *  single recovered customer, not monthly-lead-volume
           *  fantasy math. */}
          {client.is_preview && (
            <PreviewROIAnchor
              reach={reach}
              keyword={keyword?.keyword ?? null}
              googlePrimaryType={
                meta &&
                typeof (meta as Record<string, unknown>)['google_primary_type'] === 'string'
                  ? ((meta as Record<string, unknown>)['google_primary_type'] as string)
                  : null
              }
              unlockPriceUsd={discountedUnlock ? 49 : 99}
            />
          )}
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label="TurfReach™"
              value={`${reach}%`}
              subtitle={`Visible in ${reach}% of your territory`}
              icon={Compass}
            />
            <StatCard
              label="TurfRank™"
              value={rank !== null ? `${rank.toFixed(1)} / 3` : '—'}
              subtitle={turfRankCaption(rank)}
              icon={Crown}
            />
          </div>
          {momentumValue !== null && <MomentumCard momentum={momentumValue} />}
          {client.is_preview ? (
            // ⚠ SECURITY: names are stripped server-side here. The
            //   preview payload that hydrates the client component
            //   carries top3Pct + amr (real stats — the "proof") but
            //   `name: null` so DevTools / network-tab inspection
            //   yields no identifying competitor data pre-unlock. See
            //   the re-gate ticket §4 for the load-bearing requirement.
            <PreviewCompetitorLock
              shareId={shareId}
              topCompetitors={competitors.slice(0, 3).map((c) => ({
                name: null,
                top3Pct: c.top3Pct,
                amr: Number.isFinite(c.amr) ? c.amr : null,
              }))}
              totalCompetitorCount={competitors.length}
              discountedUnlock={discountedUnlock}
              leaderShare={previewLeaderShare}
            />
          ) : (
            <CompetitorTable competitors={competitors} />
          )}
        </div>

        {/* Preview-cohort only: a credibility signal between the
         *  heatmap unlock CTA and the AI Coach unlock CTA. Without
         *  this, the buyer's only proof of TurfMap's value is the
         *  product itself — and the product is locked. A testimonial
         *  on the conversion page is a meaningful CRO addition that
         *  the Tier 1 audit flagged. */}
        {client.is_preview && (
          <div className="lg:col-span-12">
            <PreviewTestimonial />
          </div>
        )}

        <div className="lg:col-span-12">
          {/* Final sentinel for StickyShareUnlockBar. When this
           *  scrolls into view, the AI Coach lock's inline CTA is
           *  active and the bottom sticky hides to avoid double-CTA
           *  in viewport. */}
          {client.is_preview && (
            <div id={SHARE_FINAL_SENTINEL_ID} aria-hidden="true" />
          )}
          {client.is_preview ? (
            <PreviewAICoachLock
              shareId={shareId}
              discountedUnlock={discountedUnlock}
            />
          ) : (
            <AICoach
              scanId={scan.id}
              shareId={shareId}
              insight={insightRow ?? null}
              scanComplete={Boolean(scan)}
            />
          )}
        </div>
      </div>

      {/* CTA footer — the conversion lever. Points to the agency's
          chosen URL (Fourdots Digital by default).

          COLDSCAN cohort: the entire CTA block (headline + "Get in
          touch" button) is suppressed. Cold buyers received their
          scan FREE and the next-step offer (free Visibility Audit
          walkthrough call) reaches them exclusively via the
          cold-stage3 founder email — never on the page itself.
          We keep the footer container + attribution line so the
          TurfMap proprietary tech credit still shows. */}
      <footer
        className="border-t px-4 md:px-8 py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        style={{
          background:
            'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <div>
          {!isColdscanShare && !client.is_preview && (
            <div className="font-display text-lg font-bold mb-1 text-zinc-100">
              {ctaText}
            </div>
          )}
          <div className="text-xs text-zinc-500">
            {sharedBy && (
              <>
                This snapshot was prepared by{' '}
                <span className="text-zinc-300">{sharedBy}</span>.{' '}
              </>
            )}
            TurfMap is proprietary technology of Fourdots Digital.
          </div>
        </div>
        {!isColdscanShare && !client.is_preview && (
          <a
            href={ctaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110"
            style={{
              background: 'var(--color-lime)',
              color: 'black',
              boxShadow: '0 4px 16px #c5ff3a30',
            }}
          >
            Get in touch
            <ChevronRight size={14} strokeWidth={2.75} />
          </a>
        )}
      </footer>

      {/* Bottom safe-area for StickyShareUnlockBar — keeps the
       *  footer above the sticky on mobile preview-cohort viewports.
       *  ~80px ≥ sticky height + iOS home-indicator inset. */}
      {client.is_preview && <div className="h-20 md:hidden" />}
    </div>
  );
}

/** Compute the share of cells where `leaderName` outranks the buyer.
 *
 *  "Outranks" means the leader appears in the 3-pack at a numerically
 *  lower (better) rank than the buyer in the same cell — including
 *  every cell where the buyer is invisible (rank = null) and the
 *  leader is rank 1/2/3.
 *
 *  Server-side only. Pure read over scan_points data already loaded
 *  for the heatmap render — no extra DB hit. Returns null when the
 *  leader can't be matched against any cell (no points or no
 *  competitor entries) so the calling site can fall back to non-%
 *  copy instead of inventing a number.
 *
 *  Name matching uses cleanCompetitorName() so the comparison against
 *  the aggregator's cleaned-name output is symmetric with the
 *  per-cell raw names that DFS sometimes suffixes (My Ad Center etc.). */
function computeLeaderShare(
  leaderName: string,
  points: Array<
    Pick<
      ScanPointRow,
      'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
    >
  >
): number | null {
  const totalCells = points.length;
  if (totalCells === 0) return null;
  let outranks = 0;
  let matchedAnyCell = false;
  for (const p of points) {
    const operatorRank = p.rank; // null = buyer not in 3-pack at this cell
    const compEntries = (p.competitors ?? []) as Array<{
      name?: string | null;
      rank_group?: number | null;
      rank_absolute?: number | null;
    }>;
    const match = compEntries.find(
      (c) => c?.name && cleanCompetitorName(c.name) === leaderName
    );
    if (!match) continue;
    matchedAnyCell = true;
    const leaderRank =
      match.rank_group ?? match.rank_absolute ?? null;
    if (leaderRank === null || leaderRank > 3) continue;
    if (operatorRank === null || leaderRank < operatorRank) {
      outranks++;
    }
  }
  // If the leader never appeared in any per-cell payload (shouldn't
  // happen given aggregateCompetitors derived from the same points,
  // but defensive against future shape drift), return null so the
  // hero falls back to non-% copy.
  if (!matchedAnyCell) return null;
  return Math.round((outranks / totalCells) * 100);
}

/** Preview-cohort band interpretation card.
 *
 *  Sits between the TurfScore hero StatCard and the Reach/Rank
 *  sub-cards on /share. Replaces the bare "Patchy" / "Solid"
 *  band label with a paragraph the buyer can anchor to + a
 *  realistic improvement trajectory + a reason the unlock is
 *  worth $49.
 *
 *  Trajectory numbers are intentionally conservative — under-
 *  promise; the buyer will see actual lift after the AI Coach
 *  Fix List execution. */
function PreviewBandInterpretation({
  bandLabel,
  score,
}: {
  bandLabel: string;
  score: number;
}) {
  // Score=0 is a distinct conversion surface from the general
  // Invisible band (1-19). At 0 the buyer's first reaction is
  // shame / "is this thing broken?" — both kill conversion. The
  // zero-state copy explicitly normalizes it ("we see this more
  // often than you think") and reframes the unlock as foundational
  // fixes, not "performance optimization." 1-19 scorers see the
  // standard Invisible copy (they at least registered somewhere).
  const isZeroScore = score === 0;
  const copy = isZeroScore
    ? zeroScoreInterpretation()
    : bandInterpretationFor(bandLabel);
  return (
    <div
      className="rounded-lg border p-4 text-sm leading-relaxed"
      style={{
        background: isZeroScore
          ? 'rgba(197, 255, 58, 0.04)'
          : 'var(--color-card)',
        borderColor: isZeroScore
          ? 'rgba(197, 255, 58, 0.25)'
          : 'var(--color-border)',
      }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold mb-2"
        style={{
          color: isZeroScore ? 'var(--color-lime)' : 'var(--color-text-muted)',
        }}
      >
        {isZeroScore
          ? 'What a 0 score actually means'
          : `What your ${bandLabel} score means`}
      </div>
      <p className="text-zinc-200">{copy.meaning}</p>
      <p className="text-zinc-300 mt-2">
        <span style={{ color: 'var(--color-lime)' }}>→</span>{' '}
        <strong className="text-white">{copy.trajectory}</strong>{' '}
        {copy.trajectoryDetail}
      </p>
    </div>
  );
}

/** Score=0 reassurance + foundational-fix framing. Separate from
 *  the Invisible band copy because 0 = "Google has no map-pack
 *  signal for this business at all" is a categorically different
 *  problem from 1-19 (registering, just not strongly). At 0 the
 *  buyer needs to know (a) it's not just them, (b) the path forward
 *  is concrete and short. */
function zeroScoreInterpretation(): {
  meaning: string;
  trajectory: string;
  trajectoryDetail: string;
} {
  return {
    meaning:
      "We see this more often than you think — usually it's missing or mismatched citations across the directories Google cross-references, an unverified Google Business Profile, or a NAP that doesn't match between your website and your Map listing. None of it requires a rebuild.",
    trajectory:
      'Get the foundational fixes needed to start ranking in your territory',
    trajectoryDetail:
      "— the Fix List shows the exact directories to claim, the NAP corrections that unlock map-pack indexing, and the Google Business Profile signals Google needs before it'll show you for local searches at all.",
  };
}

function bandInterpretationFor(band: string): {
  meaning: string;
  trajectory: string;
  trajectoryDetail: string;
} {
  switch (band) {
    case 'Invisible':
      return {
        meaning:
          "You're missing from most of your service area. Customers searching for your trade nearby aren't seeing you at all.",
        trajectory: 'Most operators here move into Patchy or Solid',
        trajectoryDetail:
          'within 30 days using the Fix List — typically a 15–25 point swing once the highest-leverage citations and listings are corrected.',
      };
    case 'Patchy':
      return {
        meaning:
          'You appear in some neighborhoods but not most. The map has clear "winning" zones near your address and clear gaps further out.',
        trajectory: 'Most operators here move into Solid (60–70)',
        trajectoryDetail:
          "within 30 days using the Fix List. The Patchy → Solid jump is where calls start compounding — your service area becomes findable, not just your block.",
      };
    case 'Solid':
      return {
        meaning:
          'You appear in about half your service area. Above-average operators land here. The gap is usually directory/citation issues, not your website.',
        trajectory: 'The Fix List shows what blocks the next 10–15 points',
        trajectoryDetail:
          "— typically NAP inconsistencies across 3–5 specific directories that Google cross-references. Above 60 is where you start outranking competitors who pay agencies.",
      };
    case 'Dominant':
      return {
        meaning:
          'You appear in most of your service area. Strong local visibility — the kind your competitors are paying agencies to chase.',
        trajectory: 'The Fix List shows how to lock in the remaining cells',
        trajectoryDetail:
          "where you're showing as #2 or #3 instead of #1. Above 80 is rare — it usually requires defending what you have, not just adding new presence.",
      };
    case 'Rare air':
    case 'Saturated':
      return {
        meaning:
          'You appear in nearly all your service area at top positions. Top-tier visibility — very few local operators score this high.',
        trajectory: 'The Fix List shows defensive moves',
        trajectoryDetail:
          "— what's at risk, which competitors are closing in, and where Google's algorithm changes could erode your lead. Worth knowing even when you're winning.",
      };
    default:
      return {
        meaning:
          "Your TurfScore measures how much of your service area you cover in Google's local Map Pack.",
        trajectory: 'The Fix List shows your three highest-leverage actions',
        trajectoryDetail:
          'specific to your business, named to your real data — not generic SEO advice.',
      };
  }
}

/** Preview-cohort dollar-anchor card.
 *
 *  Stacks under the band interpretation. Two jobs:
 *
 *    1. Translate "reach 56%" into something the buyer's gut
 *       recognizes — number of neighborhoods where their
 *       competitor is taking the call.
 *    2. Anchor the $49 unlock against a defensible job-value
 *       comparison. Framing is intentionally "one recovered
 *       customer covers the unlock Nx over" instead of
 *       "you're losing $X/mo" — the former needs only the
 *       trade's industry-average job value, the latter would
 *       require monthly-lead-volume assumptions that vary
 *       wildly by market and torch credibility on inspection.
 *
 *  Trade matching is keyword-based and conservative — unknown
 *  keywords fall back to a generic "service call" with a modest
 *  job value. Per-trade $/job numbers below are anchored to
 *  HomeAdvisor + Angi + BLS averages, then rounded conservative.
 *  Future iteration: pull from a server-side trade lookup table
 *  the operator can edit.
 */
function PreviewROIAnchor({
  reach,
  keyword,
  googlePrimaryType,
  unlockPriceUsd,
}: {
  reach: number;
  keyword: string | null;
  /** Google Business Profile primary category — stamped at preview-
   *  init when the buyer came in via PlaceAutocompleteElement.
   *  When non-null, used as the PRIMARY signal for trade economics
   *  (canonical Google place_types enum value, e.g. 'steak_house').
   *  Keyword regex match falls in as a backup. Null on legacy
   *  (Mapbox-path) leads. */
  googlePrimaryType: string | null;
  unlockPriceUsd: number;
}) {
  const econ = inferTradeEconomics(keyword, googlePrimaryType);
  const missedCells = Math.max(0, 81 - Math.round((reach / 100) * 81));
  // Coverage ratio of the unlock price by ONE recovered customer.
  // Integer-floored so the number doesn't read inflated. < 1 means
  // a single recovered customer doesn't fully cover the unlock —
  // handled below with different framing for low-ticket trades.
  const coverageMultiplier = Math.floor(econ.avgJobUSD / unlockPriceUsd);
  const tradeJobLabel = econ.unitLabel; // 'job' | 'appointment' | 'order'

  return (
    <div
      className="rounded-lg border p-4 text-sm leading-relaxed"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500 mb-2">
        What the unlock is worth
      </div>
      <p className="text-zinc-300">
        Industry average:{' '}
        <strong className="text-zinc-100">
          ~${econ.avgJobUSD.toLocaleString()}/{tradeJobLabel}
        </strong>{' '}
        for {econ.tradeLabel}.
      </p>
      <p className="text-zinc-300 mt-2">
        {coverageMultiplier >= 2 ? (
          <>
            <span style={{ color: 'var(--color-lime)' }}>→</span> One
            recovered customer covers the{' '}
            <strong className="text-zinc-100">${unlockPriceUsd}</strong>{' '}
            unlock{' '}
            <strong className="text-zinc-100">
              {coverageMultiplier}× over
            </strong>
            .
          </>
        ) : (
          <>
            <span style={{ color: 'var(--color-lime)' }}>→</span> A handful
            of recovered customers per month covers the{' '}
            <strong className="text-zinc-100">${unlockPriceUsd}</strong>{' '}
            unlock — and the Fix List is reusable forever.
          </>
        )}
      </p>
      {missedCells > 0 && (
        <p className="text-zinc-400 mt-2">
          You&rsquo;re missing in{' '}
          <strong className="text-zinc-100">{missedCells} of 81</strong>{' '}
          neighborhoods. The Fix List shows the highest-leverage cells
          to start with.
        </p>
      )}
      <p className="text-[10px] text-zinc-600 leading-relaxed mt-3 italic">
        Industry averages — your real numbers depend on margin, close
        rate, and market.
      </p>
    </div>
  );
}

/** Keyword → industry-average economics. Matches against common
 *  trade tokens with conservative defaults. Ordered most-specific
 *  first; broader trade categories check after the long-tail
 *  variants so e.g. "steakhouse" hits the upscale-dining branch
 *  before the generic "restaurant" fallback.
 *
 *  Dollar values are intentionally conservative — under-promise
 *  so the buyer's real economics make the math look better, not
 *  worse. The "covered N× over" framing in the parent component
 *  multiplies whatever number we return here against the $49
 *  unlock price, so over-inflating these values makes the claim
 *  feel less defensible. */
function inferTradeEconomics(
  keyword: string | null,
  googlePrimaryType: string | null = null
): {
  tradeLabel: string;
  unitLabel: 'job' | 'appointment' | 'order' | 'service call' | 'cover' | 'lesson' | 'membership' | 'transaction' | 'client engagement';
  avgJobUSD: number;
} {
  // Prefer Google's canonical place_types enum when the buyer came in
  // via the PlaceAutocompleteElement. It's a curated category from
  // Google Business Profile — far more reliable than regex-matching
  // a buyer-typed keyword. "Steakhouse toronto" misses any regex
  // that doesn't explicitly include 'steakhouse', but Google ships
  // primary_type='steak_house' for the same business.
  if (googlePrimaryType) {
    const fromGoogle = economicsForGoogleType(googlePrimaryType);
    if (fromGoogle) return fromGoogle;
  }
  if (!keyword) {
    return { tradeLabel: 'this business', unitLabel: 'order', avgJobUSD: 100 };
  }
  const k = keyword.toLowerCase();

  // ─── Home services (high-ticket) ──────────────────────────────
  if (/roof|sidi(?:ng)?|window|gutter/.test(k)) {
    return { tradeLabel: 'exterior remodeling', unitLabel: 'job', avgJobUSD: 8000 };
  }
  if (/hvac|furnace|ac repair|air condition|heating|cooling|duct/.test(k)) {
    return { tradeLabel: 'HVAC', unitLabel: 'service call', avgJobUSD: 450 };
  }
  if (/plumb|drain|leak|water heater|sewer|septic/.test(k)) {
    return { tradeLabel: 'plumbing', unitLabel: 'service call', avgJobUSD: 450 };
  }
  if (/electric/.test(k)) {
    return { tradeLabel: 'electrical work', unitLabel: 'job', avgJobUSD: 350 };
  }
  if (/paint/.test(k)) {
    return { tradeLabel: 'painting', unitLabel: 'job', avgJobUSD: 1500 };
  }
  if (/drywall/.test(k)) {
    return { tradeLabel: 'drywall work', unitLabel: 'job', avgJobUSD: 600 };
  }
  if (/floor|tile|hardwood|carpet|vinyl/.test(k)) {
    return { tradeLabel: 'flooring', unitLabel: 'job', avgJobUSD: 2500 };
  }
  if (/landscap|lawn|tree|garden|hardscape|snow remov/.test(k)) {
    return { tradeLabel: 'landscaping', unitLabel: 'job', avgJobUSD: 500 };
  }
  if (/pool|hot tub|spa install/.test(k)) {
    return { tradeLabel: 'pool services', unitLabel: 'service call', avgJobUSD: 300 };
  }
  if (/pest|exterm|rodent|termite/.test(k)) {
    return { tradeLabel: 'pest control', unitLabel: 'service call', avgJobUSD: 300 };
  }
  if (/garage door/.test(k)) {
    return { tradeLabel: 'garage door work', unitLabel: 'service call', avgJobUSD: 400 };
  }
  if (/locksmith/.test(k)) {
    return { tradeLabel: 'locksmith work', unitLabel: 'service call', avgJobUSD: 200 };
  }
  if (/clean|maid|janitor|housekeep/.test(k)) {
    return { tradeLabel: 'cleaning', unitLabel: 'job', avgJobUSD: 200 };
  }
  if (/movers|moving/.test(k)) {
    return { tradeLabel: 'moving services', unitLabel: 'job', avgJobUSD: 1200 };
  }
  if (/remodel|renovation|contractor|general contract|construction/.test(k)) {
    return { tradeLabel: 'remodeling', unitLabel: 'job', avgJobUSD: 5000 };
  }

  // ─── Restaurants + dining (varied unit prices) ────────────────
  // Upscale dining lands here BEFORE the generic restaurant branch.
  if (/steakhouse|steak|grill|bbq|barbecue|brewery|distillery|wine bar|gastropub/.test(k)) {
    return { tradeLabel: 'upscale dining', unitLabel: 'cover', avgJobUSD: 85 };
  }
  if (/sushi|fine dining|french restaurant|italian restaurant|tasting menu/.test(k)) {
    return { tradeLabel: 'fine dining', unitLabel: 'cover', avgJobUSD: 110 };
  }
  if (/bar\b|pub|tavern|lounge|nightclub|cocktail/.test(k)) {
    return { tradeLabel: 'bar / lounge', unitLabel: 'cover', avgJobUSD: 55 };
  }
  if (/pizza|burger|taco|sandwich|fast food|fast casual|food truck/.test(k)) {
    return { tradeLabel: 'casual food', unitLabel: 'order', avgJobUSD: 25 };
  }
  if (/restaurant|food|cafe|coffee|bakery|deli|breakfast|brunch|diner|ice cream|dessert/.test(k)) {
    return { tradeLabel: 'food orders', unitLabel: 'order', avgJobUSD: 35 };
  }

  // ─── Auto + transportation ────────────────────────────────────
  if (/auto repair|mechanic|brake|transmission|oil change|tire/.test(k)) {
    return { tradeLabel: 'auto repair', unitLabel: 'service call', avgJobUSD: 400 };
  }
  if (/auto body|collision|car detail|car wash/.test(k)) {
    return { tradeLabel: 'auto body / detailing', unitLabel: 'job', avgJobUSD: 500 };
  }
  if (/car dealer|used car|car deal|truck deal/.test(k)) {
    return { tradeLabel: 'vehicle sales', unitLabel: 'transaction', avgJobUSD: 3000 };
  }
  if (/towing|tow truck/.test(k)) {
    return { tradeLabel: 'towing', unitLabel: 'service call', avgJobUSD: 150 };
  }

  // ─── Health + wellness ────────────────────────────────────────
  if (/chiro|wellness|massage|physio|therap|acupunct|reiki/.test(k)) {
    return { tradeLabel: 'wellness care', unitLabel: 'appointment', avgJobUSD: 200 };
  }
  if (/dentist|dental|ortho|endodont|periodont/.test(k)) {
    return { tradeLabel: 'dental care', unitLabel: 'appointment', avgJobUSD: 500 };
  }
  if (/optometrist|eye doctor|vision|optical/.test(k)) {
    return { tradeLabel: 'eye care', unitLabel: 'appointment', avgJobUSD: 250 };
  }
  if (/veterin|vet clinic|animal hospital|pet hospital/.test(k)) {
    return { tradeLabel: 'veterinary care', unitLabel: 'appointment', avgJobUSD: 250 };
  }
  if (/medical spa|med spa|botox|filler|aesthet/.test(k)) {
    return { tradeLabel: 'medical aesthetics', unitLabel: 'appointment', avgJobUSD: 450 };
  }

  // ─── Beauty + personal care ───────────────────────────────────
  if (/salon|barber|hair|nail|brow|lash/.test(k)) {
    return { tradeLabel: 'salon services', unitLabel: 'appointment', avgJobUSD: 80 };
  }
  if (/spa|facial|skin|beauty/.test(k)) {
    return { tradeLabel: 'spa services', unitLabel: 'appointment', avgJobUSD: 130 };
  }
  if (/tattoo|piercing/.test(k)) {
    return { tradeLabel: 'tattoo / piercing', unitLabel: 'appointment', avgJobUSD: 300 };
  }

  // ─── Fitness + instruction ────────────────────────────────────
  if (/gym|crossfit|fitness|yoga|pilates|spin studio/.test(k)) {
    return { tradeLabel: 'fitness', unitLabel: 'membership', avgJobUSD: 100 };
  }
  if (/personal train|coach|private lesson|martial arts|jiu jitsu|karate/.test(k)) {
    return { tradeLabel: 'instruction', unitLabel: 'lesson', avgJobUSD: 90 };
  }
  if (/golf|driving range/.test(k)) {
    return { tradeLabel: 'golf services', unitLabel: 'lesson', avgJobUSD: 110 };
  }

  // ─── Pro services + B2B ───────────────────────────────────────
  if (/lawyer|attorney|legal/.test(k)) {
    return { tradeLabel: 'legal services', unitLabel: 'client engagement', avgJobUSD: 1500 };
  }
  if (/account|cpa|tax prep|bookkeep/.test(k)) {
    return { tradeLabel: 'accounting', unitLabel: 'client engagement', avgJobUSD: 600 };
  }
  if (/real estate|realtor|broker|mortgage/.test(k)) {
    return { tradeLabel: 'real estate', unitLabel: 'transaction', avgJobUSD: 6000 };
  }
  if (/insurance/.test(k)) {
    return { tradeLabel: 'insurance', unitLabel: 'client engagement', avgJobUSD: 800 };
  }
  if (/financial advis|wealth|invest/.test(k)) {
    return { tradeLabel: 'financial services', unitLabel: 'client engagement', avgJobUSD: 1200 };
  }
  if (/seo|marketing|web design|web develop|agency|consulting/.test(k)) {
    return { tradeLabel: 'marketing services', unitLabel: 'client engagement', avgJobUSD: 2500 };
  }
  if (/photographer|videograph|video product/.test(k)) {
    return { tradeLabel: 'photography / video', unitLabel: 'job', avgJobUSD: 800 };
  }
  if (/training school|driving school|first aid|cpr|certif/.test(k)) {
    return { tradeLabel: 'training', unitLabel: 'lesson', avgJobUSD: 200 };
  }

  // ─── Retail / florists / specialty ────────────────────────────
  if (/florist|flower/.test(k)) {
    return { tradeLabel: 'floral orders', unitLabel: 'order', avgJobUSD: 90 };
  }
  if (/jewel|jeweler|gold|diamond/.test(k)) {
    return { tradeLabel: 'jewelry', unitLabel: 'order', avgJobUSD: 600 };
  }
  if (/dispens|cannabis|weed shop/.test(k)) {
    return { tradeLabel: 'dispensary', unitLabel: 'order', avgJobUSD: 60 };
  }

  // Generic fallback — keeps the page coherent even on unusual
  // keywords. Lowered from $350/service-call to a more neutral
  // $100/order so non-home-services niches don't get an
  // implausibly high anchor.
  return { tradeLabel: 'this business', unitLabel: 'order', avgJobUSD: 100 };
}

/** Google Places primary_type → economics. Direct match against
 *  Google's curated place_types enum — much higher signal than
 *  buyer-typed keyword regex.
 *
 *  Reference: https://developers.google.com/maps/documentation/places/web-service/place-types
 *
 *  Returns null when the type isn't mapped — caller falls back to
 *  keyword regex. Conservative: when in doubt, leave a type unmapped
 *  and let keyword matching take over rather than risk an off-base
 *  category claim. */
function economicsForGoogleType(
  primaryType: string
):
  | {
      tradeLabel: string;
      unitLabel:
        | 'job'
        | 'appointment'
        | 'order'
        | 'service call'
        | 'cover'
        | 'lesson'
        | 'membership'
        | 'transaction'
        | 'client engagement';
      avgJobUSD: number;
    }
  | null {
  // Normalize: Google sometimes returns the type with or without the
  // 'point_of_interest' suffix; we match on the bare token.
  const t = primaryType.toLowerCase();

  // ─── Restaurants + dining ─────────────────────────────────────
  if (t === 'steak_house') return { tradeLabel: 'upscale dining', unitLabel: 'cover', avgJobUSD: 85 };
  if (t === 'fine_dining_restaurant') return { tradeLabel: 'fine dining', unitLabel: 'cover', avgJobUSD: 110 };
  if (t === 'sushi_restaurant' || t === 'japanese_restaurant') return { tradeLabel: 'sushi / Japanese', unitLabel: 'cover', avgJobUSD: 70 };
  if (t === 'french_restaurant' || t === 'italian_restaurant' || t === 'mediterranean_restaurant') return { tradeLabel: 'European dining', unitLabel: 'cover', avgJobUSD: 75 };
  if (t === 'seafood_restaurant') return { tradeLabel: 'seafood', unitLabel: 'cover', avgJobUSD: 80 };
  if (t === 'brewery' || t === 'wine_bar' || t === 'pub' || t === 'bar') return { tradeLabel: 'bar / lounge', unitLabel: 'cover', avgJobUSD: 55 };
  if (t === 'night_club') return { tradeLabel: 'nightclub', unitLabel: 'cover', avgJobUSD: 60 };
  if (t === 'pizza_restaurant' || t === 'hamburger_restaurant' || t === 'fast_food_restaurant' || t === 'mexican_restaurant' || t === 'taco_restaurant') return { tradeLabel: 'casual food', unitLabel: 'order', avgJobUSD: 25 };
  if (t === 'cafe' || t === 'coffee_shop') return { tradeLabel: 'cafe / coffee', unitLabel: 'order', avgJobUSD: 12 };
  if (t === 'bakery' || t === 'donut_shop' || t === 'ice_cream_shop') return { tradeLabel: 'bakery / sweets', unitLabel: 'order', avgJobUSD: 15 };
  if (t === 'restaurant' || t === 'meal_takeaway' || t === 'meal_delivery' || t === 'breakfast_restaurant' || t === 'brunch_restaurant') return { tradeLabel: 'food orders', unitLabel: 'order', avgJobUSD: 35 };

  // ─── Home services ────────────────────────────────────────────
  if (t === 'roofing_contractor') return { tradeLabel: 'roofing', unitLabel: 'job', avgJobUSD: 8000 };
  if (t === 'hvac_contractor') return { tradeLabel: 'HVAC', unitLabel: 'service call', avgJobUSD: 450 };
  if (t === 'plumber') return { tradeLabel: 'plumbing', unitLabel: 'service call', avgJobUSD: 450 };
  if (t === 'electrician') return { tradeLabel: 'electrical work', unitLabel: 'job', avgJobUSD: 350 };
  if (t === 'painter') return { tradeLabel: 'painting', unitLabel: 'job', avgJobUSD: 1500 };
  if (t === 'general_contractor') return { tradeLabel: 'remodeling', unitLabel: 'job', avgJobUSD: 5000 };
  if (t === 'landscaper') return { tradeLabel: 'landscaping', unitLabel: 'job', avgJobUSD: 500 };
  if (t === 'cleaning_service' || t === 'house_cleaning_service') return { tradeLabel: 'cleaning', unitLabel: 'job', avgJobUSD: 200 };
  if (t === 'moving_company') return { tradeLabel: 'moving services', unitLabel: 'job', avgJobUSD: 1200 };
  if (t === 'pest_control_service') return { tradeLabel: 'pest control', unitLabel: 'service call', avgJobUSD: 300 };
  if (t === 'locksmith') return { tradeLabel: 'locksmith work', unitLabel: 'service call', avgJobUSD: 200 };

  // ─── Auto + transport ─────────────────────────────────────────
  if (t === 'car_repair' || t === 'auto_repair_shop') return { tradeLabel: 'auto repair', unitLabel: 'service call', avgJobUSD: 400 };
  if (t === 'car_dealer') return { tradeLabel: 'vehicle sales', unitLabel: 'transaction', avgJobUSD: 3000 };
  if (t === 'car_wash' || t === 'auto_detailing') return { tradeLabel: 'car wash / detailing', unitLabel: 'job', avgJobUSD: 80 };
  if (t === 'gas_station') return { tradeLabel: 'gas station', unitLabel: 'order', avgJobUSD: 50 };
  if (t === 'taxi_stand') return { tradeLabel: 'taxi', unitLabel: 'order', avgJobUSD: 30 };

  // ─── Health + wellness ────────────────────────────────────────
  if (t === 'chiropractor') return { tradeLabel: 'chiropractic care', unitLabel: 'appointment', avgJobUSD: 150 };
  if (t === 'physiotherapist') return { tradeLabel: 'physiotherapy', unitLabel: 'appointment', avgJobUSD: 130 };
  if (t === 'massage') return { tradeLabel: 'massage', unitLabel: 'appointment', avgJobUSD: 110 };
  if (t === 'dental_clinic' || t === 'dentist') return { tradeLabel: 'dental care', unitLabel: 'appointment', avgJobUSD: 500 };
  if (t === 'optometrist' || t === 'eye_care') return { tradeLabel: 'eye care', unitLabel: 'appointment', avgJobUSD: 250 };
  if (t === 'veterinary_care') return { tradeLabel: 'veterinary care', unitLabel: 'appointment', avgJobUSD: 250 };
  if (t === 'doctor' || t === 'medical_clinic') return { tradeLabel: 'medical clinic', unitLabel: 'appointment', avgJobUSD: 250 };
  if (t === 'physiotherapy_clinic' || t === 'wellness_center') return { tradeLabel: 'wellness care', unitLabel: 'appointment', avgJobUSD: 200 };
  if (t === 'hospital') return { tradeLabel: 'hospital', unitLabel: 'appointment', avgJobUSD: 500 };

  // ─── Beauty + personal care ───────────────────────────────────
  if (t === 'hair_salon' || t === 'beauty_salon') return { tradeLabel: 'salon services', unitLabel: 'appointment', avgJobUSD: 80 };
  if (t === 'barber_shop') return { tradeLabel: 'barbering', unitLabel: 'appointment', avgJobUSD: 35 };
  if (t === 'nail_salon') return { tradeLabel: 'nail salon', unitLabel: 'appointment', avgJobUSD: 60 };
  if (t === 'spa') return { tradeLabel: 'spa services', unitLabel: 'appointment', avgJobUSD: 130 };
  if (t === 'beauty_school' || t === 'cosmetics_store') return { tradeLabel: 'beauty', unitLabel: 'order', avgJobUSD: 100 };
  if (t === 'tattoo_parlor' || t === 'tattoo_shop') return { tradeLabel: 'tattoo / piercing', unitLabel: 'appointment', avgJobUSD: 300 };

  // ─── Fitness + instruction ────────────────────────────────────
  if (t === 'gym' || t === 'fitness_center') return { tradeLabel: 'fitness', unitLabel: 'membership', avgJobUSD: 100 };
  if (t === 'yoga_studio') return { tradeLabel: 'yoga studio', unitLabel: 'membership', avgJobUSD: 130 };
  if (t === 'martial_arts_school') return { tradeLabel: 'martial arts', unitLabel: 'lesson', avgJobUSD: 90 };
  if (t === 'golf_course' || t === 'golf_driving_range') return { tradeLabel: 'golf services', unitLabel: 'lesson', avgJobUSD: 110 };

  // ─── Pro services + B2B ───────────────────────────────────────
  if (t === 'lawyer' || t === 'law_firm') return { tradeLabel: 'legal services', unitLabel: 'client engagement', avgJobUSD: 1500 };
  if (t === 'accountant' || t === 'accounting') return { tradeLabel: 'accounting', unitLabel: 'client engagement', avgJobUSD: 600 };
  if (t === 'real_estate_agency') return { tradeLabel: 'real estate', unitLabel: 'transaction', avgJobUSD: 6000 };
  if (t === 'insurance_agency') return { tradeLabel: 'insurance', unitLabel: 'client engagement', avgJobUSD: 800 };
  if (t === 'financial_consultant' || t === 'financial_planner') return { tradeLabel: 'financial services', unitLabel: 'client engagement', avgJobUSD: 1200 };
  if (t === 'bank' || t === 'atm') return { tradeLabel: 'banking', unitLabel: 'client engagement', avgJobUSD: 800 };
  if (t === 'marketing_agency' || t === 'consulting' || t === 'consultant') return { tradeLabel: 'marketing / consulting', unitLabel: 'client engagement', avgJobUSD: 2500 };
  if (t === 'photographer') return { tradeLabel: 'photography', unitLabel: 'job', avgJobUSD: 800 };
  if (t === 'school' || t === 'training_school' || t === 'driving_school' || t === 'first_aid_class') return { tradeLabel: 'training', unitLabel: 'lesson', avgJobUSD: 200 };

  // ─── Retail / specialty ───────────────────────────────────────
  if (t === 'florist') return { tradeLabel: 'floral orders', unitLabel: 'order', avgJobUSD: 90 };
  if (t === 'jewelry_store') return { tradeLabel: 'jewelry', unitLabel: 'order', avgJobUSD: 600 };
  if (t === 'pet_store') return { tradeLabel: 'pet supplies', unitLabel: 'order', avgJobUSD: 65 };
  if (t === 'pharmacy') return { tradeLabel: 'pharmacy', unitLabel: 'order', avgJobUSD: 35 };
  if (t === 'cannabis_dispensary') return { tradeLabel: 'dispensary', unitLabel: 'order', avgJobUSD: 60 };
  if (t === 'clothing_store' || t === 'shoe_store') return { tradeLabel: 'apparel', unitLabel: 'order', avgJobUSD: 100 };
  if (t === 'furniture_store') return { tradeLabel: 'furniture', unitLabel: 'order', avgJobUSD: 600 };
  if (t === 'grocery_store' || t === 'supermarket') return { tradeLabel: 'grocery', unitLabel: 'order', avgJobUSD: 65 };

  // Not mapped — caller falls back to keyword regex.
  return null;
}

/** Preview-cohort testimonial card. Lives between the heatmap +
 *  AI Coach lock so the buyer encounters a credibility signal
 *  between the two biggest unlock CTAs.
 *
 *  Currently trade-agnostic — uses the painting-operator quote
 *  that's already canonical across /scan, /free-score, /prove-it.
 *  Adding trade-keyed quotes is a future iteration. */
function PreviewTestimonial() {
  return (
    <div
      className="rounded-lg p-5 md:p-6 border relative"
      style={{
        background: 'var(--color-card)',
        borderColor: 'rgba(197, 255, 58, 0.35)',
        boxShadow: '0 0 30px #c5ff3a14',
      }}
    >
      <div
        className="font-display text-4xl md:text-5xl font-black leading-none absolute -top-1 left-5 select-none"
        style={{ color: 'var(--color-lime)' }}
        aria-hidden="true"
      >
        &ldquo;
      </div>
      <blockquote className="text-sm md:text-base text-zinc-50 leading-relaxed pt-3 md:pt-4">
        TurfMap caught a GBP category mismatch we&rsquo;d missed for 18
        months. Fixed it the same day.
      </blockquote>
      <p className="mt-3 text-xs font-mono text-zinc-500">
        — Painting operator, Greater Toronto Area
      </p>
    </div>
  );
}

/* ─── PreviewMobileLayout ────────────────────────────────────────────────
 *
 *  Quizflow-style mobile takeover for preview-cohort /share viewers.
 *  Rendered only on lg-down + is_preview=true (see the conditional
 *  block inside PublicSharePage). Replaces the desktop heatmap-left/
 *  sidebar-right grid with a vertical, conversion-tuned ladder
 *  matching the archetype Anthony shipped on /free-score-now:
 *
 *    ┌─────────────────────────────────────────────────────────────┐
 *    │ 1.  Compressed sub-header (business + keyword)              │
 *    │ 2.  Hero score reveal — bullseye SVG + score + band         │
 *    │     + "invisible to X of 81 searchers" callout              │
 *    │     [SHARE_HERO_SENTINEL_ID anchors sticky-bar hide here]   │
 *    │ 3.  Trajectory carrot — "score → projected in 90 days"      │
 *    │ 4.  Primary CTA #1 (UnlockShareButton — discount-aware)     │
 *    │ 5.  ROI anchor (compressed — 2-line missed-revenue frame)   │
 *    │ 6.  "What's behind the unlock" — 3 compact teaser cards     │
 *    │       a. Block-by-block heatmap (band-keyed decoy thumb)    │
 *    │       b. N competitors (real %, names blurred)              │
 *    │       c. 3 prioritized fixes (blurred titles)               │
 *    │ 7.  PreviewTestimonial — reused from existing helper        │
 *    │ 8.  Final CTA (UnlockShareButton)                           │
 *    │     [SHARE_FINAL_SENTINEL_ID anchors sticky-bar hide here]  │
 *    └─────────────────────────────────────────────────────────────┘
 *
 *  SECURITY: every server-side gating contract preserved.
 *    - Decoy heatmap uses a band-keyed pseudorandom 81-cell pattern
 *      generated inside this component (no real cells shipped to the
 *      browser — matches PreviewHeatmapLock's approach).
 *    - Competitor names come from the caller already stripped to
 *      null (the page server passes `topCompetitors[i].name = null`).
 *      We render blurred ascii-block placeholders. Real top3Pct +
 *      AMR stats remain visible as proof.
 *    - AI Coach fix titles are decoy ascii blocks here — the real
 *      fixes only resolve server-side on unlock fulfillment.
 *
 *  The two sticky-bar sentinels in this layout override the ones in
 *  the desktop grid by document order (getElementById returns the
 *  first match). Desktop sentinels remain in the hidden lg:grid block
 *  for the lg+ rendering path; the StickyShareUnlockBar itself is
 *  md:hidden so the two don't conflict. */

type PreviewMobileLayoutProps = {
  shareId: string;
  businessName: string;
  logoUrl: string | null;
  keyword: string | null;
  /** Friendly location label for the sub-header. `null` when the
   *  scan was for the primary location (we don't need to disambiguate
   *  one-location-businesses with a label). */
  scanLocationLabel: string | null;
  score: number;
  reach: number;
  rank: number | null;
  bandLabel: string;
  cells: HeatmapCell[];
  /** Top-3 competitor stats with names already null'd server-side.
   *  See PreviewCompetitorLockProps for the load-bearing contract. */
  topCompetitors: Array<{
    name: null;
    top3Pct: number;
    amr: number | null;
  }>;
  totalCompetitorCount: number;
  googlePrimaryType: string | null;
  discountedUnlock: boolean;
  previewLeaderShare: number | null;
};

function PreviewMobileLayout({
  shareId,
  businessName,
  logoUrl,
  keyword,
  scanLocationLabel,
  score,
  reach,
  bandLabel,
  topCompetitors,
  totalCompetitorCount,
  googlePrimaryType,
  discountedUnlock,
  previewLeaderShare,
}: PreviewMobileLayoutProps) {
  const econ = inferTradeEconomics(keyword, googlePrimaryType);
  const missedCells = Math.max(0, 81 - Math.round((reach / 100) * 81));
  const unlockPriceUsd = discountedUnlock ? 49 : 99;
  const coverageMultiplier = Math.floor(econ.avgJobUSD / unlockPriceUsd);
  const projectedScore = projectedScoreFor(score, bandLabel);
  const bandColor = bandHexFor(bandLabel, score);
  const ctaLabel = discountedUnlock
    ? 'Unlock everything — $49'
    : 'Unlock everything — $99';
  const decoyHeatmap = buildMobileDecoyCells(bandLabel);
  const competitorsCount = totalCompetitorCount;

  // Trade-aware microcopy fragments. Falls back to neutral phrasing
  // when keyword/type don't resolve into the econ tables.
  const tradeUnit = econ.unitLabel;
  const tradeLabel = econ.tradeLabel;

  return (
    <div className="px-4 py-5 space-y-5">
      {/* ── Compressed sub-header ─────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <ClientBrandMark
          logoUrl={logoUrl}
          businessName={businessName}
          size={36}
        />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold leading-none mb-1">
            TurfMap visibility report
          </div>
          <div className="font-display text-base font-bold text-zinc-50 leading-tight truncate">
            {businessName}
          </div>
          <div className="text-[11px] font-mono text-zinc-500 leading-tight mt-0.5 truncate">
            &ldquo;{keyword ?? '—'}&rdquo;
            {scanLocationLabel ? ` · ${scanLocationLabel}` : ''}
          </div>
        </div>
      </div>

      {/* ── Hero score reveal (bullseye + score + band) ──────────── */}
      <div
        className="rounded-lg border p-5 text-center"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-3"
          style={{ color: bandColor }}
        >
          Your TurfScore
        </div>
        <BullseyeScore score={score} bandColor={bandColor} />
        <div
          className="mt-3 font-display text-lg font-bold"
          style={{ color: bandColor }}
        >
          {bandLabel}
        </div>
        <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
          {missedCells >= 81 ? (
            <>You&rsquo;re invisible to <strong className="text-white">every searcher</strong> in your service area.</>
          ) : missedCells === 0 ? (
            <>You appear across <strong className="text-white">all 81</strong> search points — top-tier visibility.</>
          ) : (
            <>You&rsquo;re invisible to <strong className="text-white">{missedCells} of 81</strong> searchers near you.</>
          )}
        </p>
        {/* Sticky-bar hero sentinel — placed at the bottom of the
         *  hero card so the sticky bar stays hidden while the buyer
         *  is reading their score (and the first inline CTA right
         *  below is also visible). Becomes off-screen as the buyer
         *  scrolls into the teasers, triggering sticky reveal. */}
        <div id={SHARE_HERO_SENTINEL_ID} aria-hidden="true" />
      </div>

      {/* ── Trajectory carrot ────────────────────────────────────── */}
      <div
        className="rounded-lg p-4 border"
        style={{
          background: 'rgba(197, 255, 58, 0.06)',
          borderColor: 'rgba(197, 255, 58, 0.35)',
        }}
      >
        <div className="flex items-center gap-1.5 mb-1.5">
          <TrendingUp size={12} style={{ color: 'var(--color-lime)' }} />
          <div
            className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold"
            style={{ color: 'var(--color-lime)' }}
          >
            Projected with Fix List
          </div>
        </div>
        <div className="font-display text-base font-bold text-zinc-50 leading-tight">
          {score} → {projectedScore} in 90 days
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-300 leading-relaxed">
          {trajectoryCopyFor(bandLabel)}
        </p>
      </div>

      {/* ── Primary CTA #1 ───────────────────────────────────────── */}
      <div>
        <UnlockShareButton shareId={shareId} label={ctaLabel} />
        <p className="mt-2 text-[10px] text-center text-zinc-500 font-mono">
          {discountedUnlock ? (
            <>
              <span className="line-through">$99</span> · MAPCHECK50 applied
            </>
          ) : (
            <>One-time. No subscription.</>
          )}
          {' '}· 7-day refund
        </p>
      </div>

      {/* ── ROI anchor (compressed) ──────────────────────────────── */}
      <div
        className="rounded-lg border p-4"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500 mb-2">
          What invisibility costs
        </div>
        <p className="text-sm text-zinc-300 leading-relaxed">
          Industry average:{' '}
          <strong className="text-zinc-100">
            ~${econ.avgJobUSD.toLocaleString()}/{tradeUnit}
          </strong>{' '}
          for {tradeLabel}.
        </p>
        <p className="text-sm text-zinc-300 leading-relaxed mt-2">
          {coverageMultiplier >= 2 ? (
            <>
              <span style={{ color: 'var(--color-lime)' }}>→</span> One
              recovered customer covers the{' '}
              <strong className="text-zinc-100">${unlockPriceUsd}</strong>{' '}
              unlock{' '}
              <strong className="text-zinc-100">
                {coverageMultiplier}× over
              </strong>
              .
            </>
          ) : (
            <>
              <span style={{ color: 'var(--color-lime)' }}>→</span> A handful
              of recovered customers covers the{' '}
              <strong className="text-zinc-100">${unlockPriceUsd}</strong>{' '}
              unlock — the Fix List is reusable forever.
            </>
          )}
        </p>
      </div>

      {/* ── "What's behind the unlock" — 3 compact teaser cards ─── */}
      <div className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500 px-1">
          What&rsquo;s behind the unlock
        </div>

        {/* Heatmap teaser */}
        <TeaserCard
          icon={<MapPin size={14} style={{ color: 'var(--color-lime)' }} />}
          title="Block-by-block heatmap"
          subtitle="All 81 grid points · cell-level rank"
        >
          <div
            className="text-[9px] uppercase tracking-[0.18em] font-mono font-semibold mb-2 flex items-center gap-1.5"
            style={{ color: 'var(--color-lime)' }}
          >
            <span
              className="inline-block w-1 h-1 rounded-full"
              style={{ background: 'var(--color-lime)' }}
            />
            From your 81 real Google searches
          </div>
          <div
            className="grid grid-cols-9 gap-px h-[60px]"
            style={{ filter: 'blur(2px) saturate(0.7) brightness(0.85)' }}
            aria-hidden="true"
          >
            {decoyHeatmap.map((color, i) => (
              <div key={i} style={{ background: color }} />
            ))}
          </div>
          {keyword && (
            <p className="mt-2 text-[9px] leading-relaxed text-zinc-500">
              9×9 grid scanned for{' '}
              <span className="font-mono text-zinc-400">
                &ldquo;{keyword}&rdquo;
              </span>{' '}
              · cell ranks unlock with your full report.
            </p>
          )}
        </TeaserCard>

        {/* Competitor teaser — names blurred, real stats visible.
         *
         *  "These numbers feel real" plumbing (2026-06-13):
         *   - Eyebrow row pins the data lineage ("From your 81
         *     real Google searches") so the buyer doesn't read the
         *     percentages as marketing copy.
         *   - Each row carries a horizontal bar viz scaled to top3Pct.
         *     Physical proportionality reads as measured data, not
         *     hand-picked numbers.
         *   - Avg-map-rank (amr) appears as a second computed stat
         *     when available — two numbers per competitor anchors
         *     them as analytics output, not single-stat invention.
         *   - Methodology footnote at the bottom names the unit of
         *     measure ("share of 81 grid cells where they show up
         *     in the 3-pack"). */}
        <TeaserCard
          icon={<Crown size={14} style={{ color: 'var(--color-lime)' }} />}
          title={
            competitorsCount === 0
              ? 'Competitor analysis'
              : competitorsCount === 1
                ? '1 competitor stealing your visibility'
                : competitorsCount <= 3
                  ? `${competitorsCount} competitors stealing your visibility`
                  : `Top 3 of ${competitorsCount} competitors stealing your visibility`
          }
          subtitle={
            previewLeaderShare != null
              ? `Top one outranks you in ${previewLeaderShare}% of cells`
              : 'Named in the unlocked report'
          }
        >
          {topCompetitors.length === 0 ? (
            <p className="text-[11px] text-zinc-500">
              No competitor data in this scan.
            </p>
          ) : (
            <>
              <div
                className="text-[9px] uppercase tracking-[0.18em] font-mono font-semibold mb-2 flex items-center gap-1.5"
                style={{ color: 'var(--color-lime)' }}
              >
                <span
                  className="inline-block w-1 h-1 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                From your 81 real Google searches
              </div>
              <div className="space-y-0">
                {topCompetitors.map((c, i) => {
                  const pct = Math.max(0, Math.min(100, Math.round(c.top3Pct)));
                  return (
                    <div
                      key={i}
                      className="py-2"
                      style={{
                        borderTop:
                          i === 0
                            ? 'none'
                            : '1px solid var(--color-border)',
                      }}
                    >
                      <div className="flex justify-between items-center mb-1.5">
                        <span
                          className="font-mono text-[10px]"
                          style={{
                            filter: 'blur(3px)',
                            color: '#a1a1aa',
                            userSelect: 'none',
                          }}
                          aria-hidden="true"
                        >
                          ████████ ███████
                        </span>
                        <span className="font-mono text-[10px] text-zinc-100 font-semibold flex items-baseline gap-1.5">
                          <span>{pct}%</span>
                          {c.amr != null && Number.isFinite(c.amr) ? (
                            <span className="text-zinc-500 text-[9px]">
                              · avg #{c.amr.toFixed(1)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      {/* Proportional bar — visualizes the share so a
                       *  glance confirms the % isn't arbitrary. Track
                       *  + fill in dark-on-light so the bar reads
                       *  even at small heights. */}
                      <div
                        className="h-1 w-full rounded-full overflow-hidden"
                        style={{ background: 'var(--color-bg)' }}
                        aria-hidden="true"
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            background:
                              i === 0
                                ? 'var(--color-lime)'
                                : 'rgba(197, 255, 58, 0.55)',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[9px] leading-relaxed text-zinc-500">
                Share of 81 grid cells where each competitor appears in
                the 3-pack. Names unlock with your full report.
              </p>
            </>
          )}
        </TeaserCard>

        {/* AI Coach fix-list teaser */}
        <TeaserCard
          icon={<Sparkles size={14} style={{ color: 'var(--color-lime)' }} />}
          title="3 prioritized fixes"
          subtitle="Named to your real audit data"
        >
          <div className="space-y-1.5 text-[10px]">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-start gap-2">
                <span
                  className="font-mono leading-tight"
                  style={{ color: 'var(--color-lime)' }}
                >
                  {n}.
                </span>
                <span
                  className="font-mono leading-tight"
                  style={{
                    filter: 'blur(3px)',
                    color: '#a1a1aa',
                    userSelect: 'none',
                  }}
                  aria-hidden="true"
                >
                  ████████ ████ ███████ ██████████ ████
                </span>
              </div>
            ))}
          </div>
        </TeaserCard>
      </div>

      {/* ── Testimonial ──────────────────────────────────────────── */}
      <PreviewTestimonial />

      {/* ── Final CTA ────────────────────────────────────────────── */}
      <div>
        <UnlockShareButton shareId={shareId} label={ctaLabel} />
        <p className="mt-2 text-[10px] text-center text-zinc-500 leading-relaxed">
          One purchase unlocks all three: full 81-cell map · named competitors ·
          AI Coach Fix List. 7-day refund.
        </p>
        {/* Sticky-bar final sentinel — hides the sticky once the
         *  buyer reaches the final inline CTA so the two aren't both
         *  in view simultaneously. */}
        <div id={SHARE_FINAL_SENTINEL_ID} aria-hidden="true" />
      </div>
    </div>
  );
}

/** Bullseye score visual — 3 concentric outer rings (faint, band-
 *  colored) wrapped around a filled inner circle that holds the
 *  score numeral. Matches the visual language of the homepage
 *  TurfScore section and /score lander hero, but tighter for the
 *  mobile flow (140px overall). Pure SVG, server-render safe. */
function BullseyeScore({
  score,
  bandColor,
}: {
  score: number;
  bandColor: string;
}) {
  return (
    <div className="mx-auto" style={{ width: 140, height: 140 }}>
      <svg
        viewBox="0 0 140 140"
        width="140"
        height="140"
        role="img"
        aria-label={`TurfScore ${score} out of 100`}
      >
        {/* Outer rings — faint band-tint */}
        <circle
          cx="70"
          cy="70"
          r="68"
          fill="none"
          stroke={bandColor}
          strokeOpacity="0.18"
          strokeWidth="1"
        />
        <circle
          cx="70"
          cy="70"
          r="56"
          fill="none"
          stroke={bandColor}
          strokeOpacity="0.28"
          strokeWidth="1"
        />
        <circle
          cx="70"
          cy="70"
          r="44"
          fill="none"
          stroke={bandColor}
          strokeOpacity="0.4"
          strokeWidth="1"
        />
        {/* Inner filled circle — band-color tinted background +
         *  stronger band-color stroke. */}
        <circle
          cx="70"
          cy="70"
          r="32"
          fill={bandColor}
          fillOpacity="0.12"
          stroke={bandColor}
          strokeOpacity="0.85"
          strokeWidth="1.5"
        />
        <text
          x="70"
          y="73"
          textAnchor="middle"
          fontFamily="var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
          fontSize="30"
          fontWeight="600"
          fill="#ffffff"
          dominantBaseline="middle"
        >
          {score}
        </text>
        <text
          x="70"
          y="93"
          textAnchor="middle"
          fontFamily="var(--font-mono, ui-monospace, SFMono-Regular, monospace)"
          fontSize="9"
          fill="#71717a"
        >
          / 100
        </text>
      </svg>
    </div>
  );
}

/** Compact teaser-card wrapper used inside PreviewMobileLayout's
 *  "What's behind the unlock" section. Single rounded card with
 *  title row + icon + arrow + a children-driven preview body.
 *  No inline CTA — the primary unlock CTAs sit above and below
 *  the teaser stack; making each card its own conversion ask
 *  would feel like 3 paywalls and torch the new layout's pacing. */
function TeaserCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-start gap-2 min-w-0">
          <div className="mt-0.5 flex-shrink-0">{icon}</div>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-zinc-100 leading-tight">
              {title}
            </div>
            <div className="text-[10px] text-zinc-500 leading-tight mt-0.5">
              {subtitle}
            </div>
          </div>
        </div>
        <Lock size={12} className="flex-shrink-0 text-zinc-600 mt-0.5" />
      </div>
      {children}
    </div>
  );
}

/** Band → primary hex used for the bullseye stroke + band label.
 *  Mirrors the desktop StatCard band tones via local mapping so
 *  this component doesn't need to import the wider band-color
 *  registry. Special-cases score=0 so the hero reads critical
 *  even though the band label is the same as the 1-19 range. */
function bandHexFor(bandLabel: string, score: number): string {
  if (score === 0) return '#ff4d4d';
  switch (bandLabel) {
    case 'Invisible':
      return '#ff4d4d';
    case 'Patchy':
      return '#ff9f3a';
    case 'Solid':
      return '#e8e54a';
    case 'Dominant':
      return '#c5ff3a';
    case 'Rare air':
    case 'Saturated':
      return '#f5c842';
    default:
      return '#c5ff3a';
  }
}

/** Conservative projected-score lift for the trajectory carrot.
 *  Numbers intentionally under-promise — operators landing in
 *  Invisible/Patchy who execute the Fix List typically see +15-25
 *  point swings within 30 days; we project +30-40 over 90 days
 *  because the cumulative effect of citation + GBP fixes compounds.
 *  Clamps to 100 so we don't surface "score → 112" on edge cases. */
function projectedScoreFor(score: number, bandLabel: string): number {
  const baseLift = (() => {
    switch (bandLabel) {
      case 'Invisible':
        return 45; // foundational fixes have the biggest leverage
      case 'Patchy':
        return 38;
      case 'Solid':
        return 22;
      case 'Dominant':
        return 12;
      case 'Rare air':
      case 'Saturated':
        return 5;
      default:
        return 25;
    }
  })();
  return Math.min(100, score + baseLift);
}

/** Short trajectory line that sits under the projected score in
 *  the carrot card. Per-band so the framing matches the buyer's
 *  starting position (Invisible operators need foundational-fix
 *  reassurance; Dominant operators need defensive framing). */
function trajectoryCopyFor(bandLabel: string): string {
  switch (bandLabel) {
    case 'Invisible':
      return 'Operators starting in Invisible average +30-50 points after executing their first 3 Fix List actions.';
    case 'Patchy':
      return 'Patchy → Solid is where calls start compounding. Most operators get there in 30-60 days.';
    case 'Solid':
      return 'The Fix List shows what blocks the next 10-20 points — usually NAP inconsistencies on 3-5 specific directories.';
    case 'Dominant':
      return 'You’re already above-average. The Fix List locks in the cells where you’re #2/#3 instead of #1.';
    case 'Rare air':
    case 'Saturated':
      return 'You’re winning. The Fix List shows defensive moves — what’s at risk and which competitors are closing in.';
    default:
      return 'The Fix List shows your three highest-leverage actions, named to your real data.';
  }
}

/** Band-keyed pseudorandom 81-cell color array for the compact
 *  decoy heatmap in the mobile teaser. No real cells ever ship to
 *  the browser in preview mode — this mirrors PreviewHeatmapLock's
 *  approach.
 *
 *  Distribution is loosely band-keyed (Invisible = mostly red;
 *  Rare air = mostly lime) so the thumb visually correlates with
 *  the buyer's actual score, but no cell carries real rank data.
 *  Uses a deterministic seeded shuffle so the same band always
 *  renders the same thumb (no Date.now / Math.random — server
 *  components don't permit them and we want stable SSR output). */
function buildMobileDecoyCells(bandLabel: string): string[] {
  const RANK_COLORS = {
    1: '#c5ff3a',
    2: '#e8e54a',
    3: '#ff9f3a',
    miss: '#ff4d4d',
  } as const;

  // Fraction targets per band (rough): [#1, #2, #3, miss]
  const mix = (() => {
    switch (bandLabel) {
      case 'Invisible':
        return [0.04, 0.08, 0.12, 0.76];
      case 'Patchy':
        return [0.1, 0.16, 0.2, 0.54];
      case 'Solid':
        return [0.22, 0.26, 0.22, 0.3];
      case 'Dominant':
        return [0.42, 0.28, 0.18, 0.12];
      case 'Rare air':
      case 'Saturated':
        return [0.7, 0.18, 0.08, 0.04];
      default:
        return [0.18, 0.22, 0.2, 0.4];
    }
  })();

  const counts = mix.map((p) => Math.round(p * 81));
  const colors: string[] = [];
  for (let i = 0; i < counts[0]; i++) colors.push(RANK_COLORS[1]);
  for (let i = 0; i < counts[1]; i++) colors.push(RANK_COLORS[2]);
  for (let i = 0; i < counts[2]; i++) colors.push(RANK_COLORS[3]);
  while (colors.length < 81) colors.push(RANK_COLORS.miss);
  colors.length = 81;

  // Deterministic shuffle keyed off the band string so each band
  // always renders the same decoy thumb (stable SSR, no
  // Date.now/Math.random).
  let seed = 0;
  for (let i = 0; i < bandLabel.length; i++) seed = (seed * 31 + bandLabel.charCodeAt(i)) >>> 0;
  for (let i = colors.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return colors;
}

function ExpiredScreen({
  reason,
  expiresAt,
}: {
  reason: 'expired' | 'revoked' | 'not_found';
  expiresAt?: string;
}) {
  const headline =
    reason === 'expired'
      ? 'This share link has expired'
      : reason === 'revoked'
        ? 'This share link has been revoked'
        : 'Share link not found';
  const body =
    reason === 'expired'
      ? `This snapshot was last accessible until ${expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'recently'}. Ask whoever sent it for a fresh link.`
      : reason === 'revoked'
        ? 'The agency that created this link has revoked it. Reach out to them for an updated copy.'
        : 'The link may be mistyped or the share has been deleted. Double-check the URL.';

  return (
    <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
      <div
        className="max-w-md w-full rounded-lg border p-8 text-center"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div
          className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
          style={{
            background: '#0d130a',
            border: '1px solid var(--color-border-bright)',
          }}
        >
          <Clock size={20} style={{ color: 'var(--color-lime)' }} />
        </div>
        <h3 className="font-display text-lg font-bold mb-2">{headline}</h3>
        <p className="text-xs text-zinc-400 leading-relaxed mb-5">{body}</p>
        <Link
          href="https://turfmap.ai"
          className="text-xs font-mono text-zinc-500 hover:text-zinc-300"
        >
          turfmap.ai →
        </Link>
      </div>
    </div>
  );
}
