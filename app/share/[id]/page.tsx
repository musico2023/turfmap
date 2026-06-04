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

import { Crosshair, Crown, MapPin, Target, Compass, ChevronRight, Clock } from 'lucide-react';
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

      {/* Compact business meta */}
      <div
        className="border-b px-4 md:px-8 py-4 grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 items-start md:items-center"
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

      {/* Heatmap + sidebar — same shape as portal/dashboard but
          internals stripped out. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6 p-4 md:p-8">
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

        <div className="lg:col-span-4 space-y-4">
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
            <PreviewBandInterpretation bandLabel={band.label} />
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
function PreviewBandInterpretation({ bandLabel }: { bandLabel: string }) {
  const copy = bandInterpretationFor(bandLabel);
  return (
    <div
      className="rounded-lg border p-4 text-sm leading-relaxed"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500 mb-2">
        What your {bandLabel} score means
      </div>
      <p className="text-zinc-300">{copy.meaning}</p>
      <p className="text-zinc-400 mt-2">
        <span style={{ color: 'var(--color-lime)' }}>→</span>{' '}
        <strong className="text-zinc-100">{copy.trajectory}</strong>{' '}
        {copy.trajectoryDetail}
      </p>
    </div>
  );
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
  unlockPriceUsd,
}: {
  reach: number;
  keyword: string | null;
  unlockPriceUsd: number;
}) {
  const econ = inferTradeEconomics(keyword);
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
 *  trade tokens with conservative defaults. */
function inferTradeEconomics(keyword: string | null): {
  tradeLabel: string;
  unitLabel: 'job' | 'appointment' | 'order' | 'service call';
  avgJobUSD: number;
} {
  if (!keyword) {
    return { tradeLabel: 'this service', unitLabel: 'service call', avgJobUSD: 350 };
  }
  const k = keyword.toLowerCase();
  if (/roof/.test(k)) {
    return { tradeLabel: 'roofing', unitLabel: 'job', avgJobUSD: 8000 };
  }
  if (/hvac|furnace|ac repair|air condition|heating|cooling/.test(k)) {
    return { tradeLabel: 'HVAC', unitLabel: 'service call', avgJobUSD: 450 };
  }
  if (/plumb|drain|leak|water heater/.test(k)) {
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
  if (/landscap|lawn|tree|garden|hardscape/.test(k)) {
    return { tradeLabel: 'landscaping', unitLabel: 'job', avgJobUSD: 500 };
  }
  if (/pest|exterm|rodent/.test(k)) {
    return { tradeLabel: 'pest control', unitLabel: 'service call', avgJobUSD: 300 };
  }
  if (/garage door/.test(k)) {
    return { tradeLabel: 'garage door work', unitLabel: 'service call', avgJobUSD: 400 };
  }
  if (/locksmith/.test(k)) {
    return { tradeLabel: 'locksmith work', unitLabel: 'service call', avgJobUSD: 200 };
  }
  if (/clean|maid|janitor/.test(k)) {
    return { tradeLabel: 'cleaning', unitLabel: 'job', avgJobUSD: 200 };
  }
  if (/remodel|renovation|contractor|construction/.test(k)) {
    return { tradeLabel: 'remodeling', unitLabel: 'job', avgJobUSD: 5000 };
  }
  if (/chiro|wellness|massage|physio|therap/.test(k)) {
    return { tradeLabel: 'wellness care', unitLabel: 'appointment', avgJobUSD: 200 };
  }
  if (/dentist|dental|ortho/.test(k)) {
    return { tradeLabel: 'dental care', unitLabel: 'appointment', avgJobUSD: 500 };
  }
  if (/lawyer|attorney|legal/.test(k)) {
    return { tradeLabel: 'legal services', unitLabel: 'job', avgJobUSD: 1500 };
  }
  if (/salon|barber|hair|nail|spa/.test(k)) {
    return { tradeLabel: 'salon services', unitLabel: 'appointment', avgJobUSD: 80 };
  }
  if (/florist|flower/.test(k)) {
    return { tradeLabel: 'floral orders', unitLabel: 'order', avgJobUSD: 90 };
  }
  if (/restaurant|food|cafe|bakery|deli/.test(k)) {
    return { tradeLabel: 'food orders', unitLabel: 'order', avgJobUSD: 35 };
  }
  // Generic fallback — keeps the page coherent even on unusual keywords.
  return { tradeLabel: 'this service', unitLabel: 'service call', avgJobUSD: 350 };
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
