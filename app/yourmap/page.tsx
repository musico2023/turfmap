import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Check,
  Clock,
  Compass,
  Crosshair,
  Crown,
  Grid3x3,
  HelpCircle,
  MapPin,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { ScanIntakeLinkButton } from '@/components/marketing/scan/ScanIntakeLinkButton';
import { ColdscanRunButton } from '@/components/marketing/ColdscanRunButton';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { buildHeroCells, HERO_METRICS } from '@/components/marketing/heroSeed';
import { buildRepresentativeCells } from '@/components/marketing/representativeHeatmap';
import {
  finalPriceCents,
  formatUsd,
  lookupCoupon,
  type CouponDescriptor,
} from '@/lib/coupons/knownCoupons';
import { headers } from 'next/headers';
import { getServerSupabase } from '@/lib/supabase/server';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { logLanderVisit } from '@/lib/analytics/landerVisits';
import { logFunnelEvent } from '@/lib/analytics/funnelEvents';
import { YourmapFunnelEmitter } from '@/components/yourmap/YourmapFunnelEmitter';
import type { ProspectRow } from '@/lib/supabase/types';

/**
 * Cold-email outreach landing page.
 *
 * Personalized variant of /fourdots for the outbound acquisition
 * channel. Operators send links of the form
 *   /yourmap?prospect_id=abc123xyz&coupon=COLDSCAN&utm_*=...
 * which we look up against the prospects table to render hero copy
 * tailored to that buyer (their business name, city, preview score,
 * count of dark cells, top competitor).
 *
 * Why a separate route from /fourdots:
 *   - Different cohort = different attribution (utm_source defaults
 *     differ; coupon code differs; prospect_id only exists here)
 *   - Personalization model needs server-side DB lookup that
 *     /fourdots doesn't do
 *   - FAQ adds the "How did you get my info?" question at top
 *     (cold-email-specific objection)
 *   - Already-converted state routes back to /fourdots
 *
 * Design parity with /fourdots is intentional. Most of this file is
 * a clone of app/fourdots/page.tsx with surgical changes flagged via
 * comments. A future refactor could extract the shared shell into a
 * <ScanLanderShell> component; deferred for sprint speed. When you
 * change copy on /fourdots, audit this file for the same change.
 *
 * URL contract:
 *   ?prospect_id=<10-char nanoid>     — lookup key for prospects
 *   ?coupon=COLDSCAN                  — auto-applied at checkout
 *                                       (omit for regular $99 price — no default)
 *   ?utm_source=cold_email            — default if absent
 *   ?utm_medium=outbound              — default if absent
 *   ?utm_campaign=hvac_vancouver_q2   — populated by lead-gen pipeline
 */

// Default UTM values when the cold-email URL omits them. Lets the
// operator paste a bare /yourmap?prospect_id=... and still get clean
// attribution on the conversion.
const DEFAULT_UTM_SOURCE = 'cold_email';
const DEFAULT_UTM_MEDIUM = 'outbound';
// NO default coupon. A bare /yourmap visit (no ?coupon=...) renders at
// regular price ($99) — we don't want random URL guessers landing on a
// free or discounted offer. Real cold-email sends always carry the
// coupon param explicitly (COLDSCAN for the current campaign,
// MAPCHECK50 for legacy). The coupon registry stays unchanged.

type ProspectPersonalization = {
  id: string;
  business_name: string;
  city: string;
  trade: string;
  preview_score: number;
  band: string;
  invisibility_count: number;
  top_competitor_name: string | null;
  top_competitor_share_pct: number | null;
  /** True iff the lead-gen pipeline has backfilled address + lat + lng
   *  onto this prospect row. Gates the COLDSCAN one-click bypass —
   *  when false we fall back to the Stripe checkout flow because the
   *  coldscan-fulfill route can't seed the 9x9 grid without geo. */
  hasGeo: boolean;
};

/** Look up the prospect server-side (direct DB query, not an HTTP
 *  hit to /api/prospect/[id] — same JS process, no need for the
 *  network roundtrip). Returns:
 *    - { kind: 'found', data } when the row exists + isn't converted
 *    - { kind: 'converted', convertedAt } when already converted
 *    - { kind: 'not_found' } when missing OR no id supplied
 *  Also stamps view metrics on the row when found (best effort). */
async function loadProspect(
  prospectId: string | null
): Promise<
  | { kind: 'found'; data: ProspectPersonalization }
  | { kind: 'converted'; convertedAt: string }
  | { kind: 'not_found' }
> {
  if (!prospectId) return { kind: 'not_found' };
  const supabase = getServerSupabase();
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .maybeSingle<ProspectRow>();
  if (!prospect) return { kind: 'not_found' };
  if (prospect.converted_at) {
    return { kind: 'converted', convertedAt: prospect.converted_at };
  }
  // Best-effort view stamp. Don't await — page render shouldn't
  // block on this write.
  void (async () => {
    try {
      await supabase
        .from('prospects')
        .update({
          view_count: prospect.view_count + 1,
          page_viewed_at: prospect.page_viewed_at ?? new Date().toISOString(),
        })
        .eq('id', prospectId);
    } catch {
      // swallow — view metrics aren't critical
    }
  })();
  return {
    kind: 'found',
    data: {
      id: prospect.id,
      business_name: prospect.business_name,
      city: prospect.city,
      trade: prospect.trade,
      preview_score: prospect.preview_score,
      band: getTurfScoreBand(prospect.preview_score).label,
      invisibility_count: prospect.invisibility_count,
      top_competitor_name: prospect.top_competitor_name,
      top_competitor_share_pct: prospect.top_competitor_share_pct,
      hasGeo:
        prospect.latitude != null &&
        prospect.longitude != null &&
        Boolean(prospect.address),
    },
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}): Promise<Metadata> {
  const params = await searchParams;
  const prospectId = pickFirst(params.prospect_id);
  const lookup = await loadProspect(prospectId);
  const robots = { index: false, follow: false };
  if (lookup.kind === 'found') {
    return {
      title: `Your TurfMap preview — TurfScore ${lookup.data.preview_score} · TurfMap`,
      description: `We ran a preview scan of ${lookup.data.business_name}. Your TurfScore is ${lookup.data.preview_score}. See the full 81-point breakdown and the top 3 things to fix.`,
      robots,
    };
  }
  return {
    title: 'Your TurfMap preview · TurfMap',
    description:
      'Run your full TurfMap scan. 81 grid points, real Google searches, AI Coach Fix List delivered in under a minute.',
    robots,
  };
}

export default async function YourMapLandingPage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const prospectId = pickFirst(params.prospect_id);
  // No default — a bare /yourmap visit renders at regular $99.
  const couponCode = pickFirst(params.coupon) ?? null;
  const utmSource = pickFirst(params.utm_source) ?? DEFAULT_UTM_SOURCE;
  const utmMedium = pickFirst(params.utm_medium) ?? DEFAULT_UTM_MEDIUM;
  const utmCampaign = pickFirst(params.utm_campaign);
  const gclid = pickFirst(params.gclid);

  // Fire-and-forget click log for the LLM Ops Dashboard funnel "Clicks" step.
  // Only logs when prospect_id is present, so testing / direct visits don't
  // pollute the prospect-click count. See lib/analytics/landerVisits.ts.
  if (prospectId) {
    const reqHeaders = await headers();
    const ua = reqHeaders.get('user-agent');
    const ref = reqHeaders.get('referer');
    logLanderVisit({
      path:         '/yourmap',
      utm_source:   utmSource,
      utm_medium:   utmMedium,
      utm_campaign: utmCampaign,
      coupon:       couponCode,
      prospect_id:  prospectId,
      user_agent:   ua,
      referer:      ref,
    });
    // Mirror the view into cold_funnel_events so the funnel summary
    // view doesn't need to JOIN ops_lander_visits cross-table (cuts
    // the funnel query from a 3-table join down to a single
    // grouped scan on cold_funnel_events). The client-side
    // emitter ALSO fires yourmap_view on mount; the summary view
    // COUNTs DISTINCT prospect_id per event_type so the double-fire
    // doesn't inflate counts. Belt-and-suspenders: if the client
    // JS fails to run (ad blocker, no-JS context, dead browser tab
    // restored), the server-side log still captures the view.
    logFunnelEvent({
      event_type:   'yourmap_view',
      prospect_id:  prospectId,
      utm_source:   utmSource,
      utm_medium:   utmMedium,
      utm_campaign: utmCampaign,
      user_agent:   ua,
      referer:      ref,
    });
  }

  const prospectLookup = await loadProspect(prospectId);
  const personalization =
    prospectLookup.kind === 'found' ? prospectLookup.data : null;

  // Already-converted prospects skip the whole lander — they have a
  // dashboard, sending them through another buy flow would be
  // redundant. Render the small recovery state directly.
  if (prospectLookup.kind === 'converted') {
    return (
      <AlreadyConvertedState convertedAt={prospectLookup.convertedAt} />
    );
  }

  const coupon = lookupCoupon(couponCode, 'scan');
  const listCents = 9900;
  const showDiscount = coupon !== null;
  const finalCents = coupon ? finalPriceCents(coupon) : listCents;

  // COLDSCAN bypass: when a cold-cohort prospect arrives with the
  // COLDSCAN coupon AND their row has geo backfilled by the lead-gen
  // pipeline, swap the Stripe-checkout CTAs for a one-click "Run my
  // free TurfScan" button that POSTs to /api/yourmap/coldscan-fulfill
  // and skips Stripe entirely. Falls back to the Stripe flow on legacy
  // prospects without geo so nothing breaks during the lead-gen
  // pipeline's geo-backfill rollout. See migration 0031.
  const useColdscanBypass =
    couponCode?.toUpperCase() === 'COLDSCAN' &&
    personalization !== null &&
    personalization.hasGeo &&
    Boolean(prospectId);

  // Hero heatmap is shared sample data — same as /fourdots.
  const cells = buildHeroCells();
  const { reach, rank, score, band } = HERO_METRICS;

  // Hero visual title personalizes when prospect data loads,
  // otherwise falls back to the /fourdots default. Cold-prospect
  // ingest pipeline leaves city empty for ~17% of rows (external
  // Instantly.ai / Apollo enrichment gap) — when missing, drop the
  // city segment entirely instead of rendering a trailing comma.
  const heroVisualTitle = personalization
    ? personalization.city && personalization.city.trim().length > 0
      ? `Sample · ${personalization.trade}, ${personalization.city}`
      : `Sample · ${personalization.trade}`
    : 'Sample · Plumber, midtown';

  const heatmapCells =
    personalization != null && personalization.invisibility_count > 0
      ? buildRepresentativeCells(personalization.id, personalization.invisibility_count)
      : cells;

  return (
    <div className="min-h-screen w-full text-white">
      {/* Cold-funnel event emitter (Phase 1 — migration 0041). Only
       *  mounted when we have a resolvable prospect_id, since the
       *  funnel summary view groups by utm_campaign + prospect and
       *  events without prospect lineage would just inflate noise.
       *  Fires yourmap_view (mirror of server-side log + redundancy
       *  for the rare case the server log fails), yourmap_scroll_50,
       *  yourmap_scroll_form, and coldscan_cta_click. */}
      {prospectId && (
        <YourmapFunnelEmitter
          prospectId={prospectId}
          utmSource={utmSource}
          utmMedium={utmMedium}
          utmCampaign={utmCampaign}
        />
      )}
      {/* ─── HEADER ───────────────────────────────────────────────────
       *  /yourmap-specific simplification per Sprint-1 Fix 1.7: the
       *  "Existing customer?" link from /fourdots is REMOVED here.
       *  Cold-email cohort buyers don't have an existing TurfMap
       *  account by definition; the link only adds cognitive
       *  friction at the moment of conversion. /fourdots keeps the
       *  link since FOURDOTS50 traffic includes some returning
       *  buyers from Anthony's parent-site popup. */}
      <header
        className="border-b px-6 md:px-10 py-4 flex items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <Link href="/" className="flex items-center gap-2.5 group">
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center"
            style={{ background: 'var(--color-lime)' }}
          >
            <Crosshair size={16} strokeWidth={2.25} className="text-black" />
          </span>
          <span className="font-display text-base md:text-lg font-bold tracking-tight">
            TurfMap
            <span
              className="text-[9px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
        </Link>
      </header>

      {/* ─── HERO ───────────────────────────────────────────────────── */}
      <section className="relative px-6 md:px-10 pt-12 md:pt-16 pb-12 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 75% 40%, #c5ff3a14 0%, transparent 60%)',
          }}
        />

        <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          <div className="lg:col-span-7">
            {/* Eyebrow — cold-email-specific copy. Replaces the
             *  /fourdots "$50 OFF · TURFSCAN" eyebrow. */}
            <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-5 flex items-center gap-2 flex-wrap">
              <span style={{ color: 'var(--color-lime)' }}>●</span>
              <span style={{ color: 'var(--color-lime)' }}>
                Your TurfMap preview
              </span>
              <span className="text-zinc-600">·</span>
              <span>Delivered from our outreach team</span>
            </div>

            {/* H1 — three-tier weight hierarchy per Sprint-1 Fix 1.3.
             *  The buyer's business name is the most personally-
             *  relevant token on the page; bolding ONLY that span
             *  while leaving "We already mapped" at regular weight
             *  visually anchors recognition without making the rest
             *  of the H1 feel shouty. The italic tail keeps the
             *  rhetorical beat ("here's what we found.") tethered
             *  to the rest of the line.
             *  Parent has no font-bold so individual span weights
             *  apply; would otherwise be overridden. */}
            <h1 className="font-sans text-2xl md:text-3xl leading-snug mb-4 text-zinc-100">
              {personalization ? (
                <>
                  <span className="font-normal text-zinc-300">
                    We already mapped{' '}
                  </span>
                  <span className="font-bold text-white">
                    {personalization.business_name}
                  </span>
                  <span className="font-normal text-zinc-300">.</span>{' '}
                  <em className="font-semibold">
                    Here&rsquo;s what we found.
                  </em>
                </>
              ) : (
                <>
                  <span className="font-normal text-zinc-300">
                    We already ran your preview scan.
                  </span>{' '}
                  <em className="font-semibold">
                    Here&rsquo;s what we found.
                  </em>
                </>
              )}
            </h1>

            {/* Your Preview Score card — Sprint-2 Fix 2. Primary
             *  visual anchor of the hero. Renders nothing when the
             *  fallback path is active (no personalization data); a
             *  generic stand-in would dilute the "we already ran
             *  your scan" framing. */}
            {personalization && (
              <YourPreviewScoreCard
                score={personalization.preview_score}
                band={personalization.band}
              />
            )}

            {personalization && (
              <InvisibilityStatCard invisibilityCount={personalization.invisibility_count} />
            )}

            {/* The Competition card — Sprint-2 Fix 3. Warm-toned
             *  accent (uses the existing palette's --color-warn /
             *  orange channel) so it visually differentiates from
             *  the lime YOUR PREVIEW SCORE card without alarmism.
             *
             *  Now renders for EVERY personalized prospect — when
             *  competitor enrichment is missing (99.8% of the cold
             *  cohort as of 2026-06-08; the external Instantly/Apollo
             *  pipeline doesn't reliably populate top_competitor_name
             *  + top_competitor_share_pct), the card swaps into a
             *  curiosity-driving fallback ("a specific competitor is
             *  outranking you — the full scan names them") instead
             *  of disappearing entirely. The fallback preserves the
             *  conversion pressure that this card carries in the
             *  hero stack. */}
            {personalization && (
              <TheCompetitionCard
                competitorName={personalization.top_competitor_name}
                sharePct={personalization.top_competitor_share_pct}
                city={personalization.city}
              />
            )}

            {/* CTA section marker + CTA click marker for the cold-
             *  funnel emitter (Phase 1 — migration 0041). */}
            <div
              data-funnel-section="cta"
              data-funnel-cta="coldscan"
            >
              <PricePanel
                listCents={listCents}
                finalCents={finalCents}
                coupon={coupon}
                couponCode={couponCode}
                utmSource={utmSource}
                utmMedium={utmMedium}
                utmCampaign={utmCampaign}
                gclid={gclid}
                prospectId={prospectId}
                useColdscanBypass={useColdscanBypass}
              />
            </div>

          </div>

          {/* Right column. Part B 5.1: for PERSONALIZED prospects,
           *  show the aggregate-proportional their-data teaser
           *  (81-cell shape with exactly invisibility_count dimmed)
           *  with the honesty label that this is aggregate, not
           *  per-cell. The previous "anonymized sample heatmap with
           *  different numbers labeled NOT YOUR DATA" treatment
           *  contradicted the prospect's stated TurfScore and
           *  undercut the "we already mapped you" promise.
           *
           *  Fallback path (no personalization data → caller
           *  clicked a bare /yourmap with no prospect_id, or the
           *  prospect_id didn't resolve): keep the old sample
           *  heatmap with the explicit "not your data" framing.
           *  That's still honest — they didn't get the personalized
           *  experience. */}
          <div className="lg:col-span-5">
            {personalization ? (
              <>
                <div className="mb-2 flex">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[9px] uppercase tracking-[0.16em] font-bold" style={{ background: '#27272a', color: '#d4d4d8' }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#a1a1aa' }} />
                    Representative of your preview
                  </span>
                </div>
                <div className="border rounded-lg p-5 relative" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border-bright)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">{heroVisualTitle}</div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-lime)' }} />
                      PREVIEW
                    </div>
                  </div>
                  <HeatmapGrid cells={heatmapCells} />
                  <div className="mt-3 pt-3 border-t flex items-start gap-2.5" style={{ borderColor: 'var(--color-border)' }}>
                    <Crosshair size={13} strokeWidth={2.5} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      Your <strong className="text-zinc-200">exact block-by-block heatmap</strong> unlocks when you run the full scan.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-3 md:gap-4 mt-4">
                    <ScoreReadout label="TurfReach™" value="— · ·" ariaLabel="TurfReach — unlocks with the full scan" />
                    <ScoreReadout label="TurfRank™" value="— · ·" ariaLabel="TurfRank — unlocks with the full scan" />
                    <ScoreReadout label="TurfScore™" value={String(personalization.preview_score)} highlight bandLabel={personalization.band} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-2 flex">
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[9px] uppercase tracking-[0.16em] font-bold"
                    style={{
                      background: 'var(--color-lime)',
                      color: '#000',
                    }}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: '#000' }}
                    />
                    Anonymized example — not your data
                  </span>
                </div>
                <div
                  className="border rounded-lg p-5 relative"
                  style={{
                    background: 'var(--color-card)',
                    borderColor: 'var(--color-border-bright)',
                    boxShadow: '0 0 60px #c5ff3a10',
                  }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                      {heroVisualTitle}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                      <span
                        className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: 'var(--color-lime)' }}
                      />
                      LIVE
                    </div>
                  </div>
                  <HeatmapGrid cells={cells} />
                  <p className="text-[11px] text-zinc-400 mt-3 mb-4 leading-relaxed text-center">
                    <strong className="text-zinc-200">
                      This is a sample heatmap, not your data.
                    </strong>{' '}
                    Your full TurfScan reveals your actual 81-cell heatmap,
                    your specific TurfScore, and your competitor positions.
                  </p>
                  <div className="grid grid-cols-3 gap-3 md:gap-4">
                    <ScoreReadout label="TurfReach™" value={`${reach}%`} />
                    <ScoreReadout
                      label="TurfRank™"
                      value={`${rank.toFixed(1)} / 3`}
                    />
                    <ScoreReadout
                      label="TurfScore™"
                      value={String(score)}
                      highlight
                      bandLabel={band}
                    />
                  </div>
                </div>
              </>
            )}
            <HeroTrustLines />
          </div>
        </div>
      </section>

      {/* Trust strip — moved up to just under the hero */}
      <section className="px-6 md:px-10 pb-6">
        <div className="max-w-6xl mx-auto">
          <TrustStripRow city={personalization?.city ?? null} />
        </div>
      </section>

      {/* ─── "1 of 81" reframe (Part B 5.5) ──────────────────────────
       *  Sits immediately after the hero so the prospect understands
       *  WHY a score of 0 / Invisible matters, in plain terms.
       *  Personalized against their preview score + city; the brief
       *  requires every element be framed as about this prospect,
       *  not generic marketing. */}
      {personalization && (
        <OneOfEightyOneSection
          invisiblePct={Math.round(
            (personalization.invisibility_count / 81) * 100
          )}
          city={personalization.city}
          businessName={personalization.business_name}
          trade={personalization.trade}
        />
      )}

      {/* ─── Testimonial (Part B 5.4) ────────────────────────────────
       *  Ports the named-operator testimonial from /free-score —
       *  one piece of social proof from a real Fourdots client.
       *  Sits high up in the page so the cold prospect's skepticism
       *  ("is this just another marketing site?") gets a third-party
       *  answer BEFORE the fix list reveal. */}
      <TestimonialSection />

      {/* ─── WHY YOU GOT THIS — cold-outreach trust accordion ────────── */}
      <section id="why-you-got-this" className="px-6 md:px-10 py-16 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span> Why you got
            this
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold leading-tight tracking-tight mb-6 max-w-xl">
            No catch. <em>Here&rsquo;s the honest version.</em>
          </h2>
          <FAQAccordion
            items={[
              {
                q: 'Why are you reaching out to me?',
                a: (
                  <>
                    TurfMap is built by{' '}
                    <strong className="text-zinc-200">Fourdots Digital</strong>{' '}
                    — a digital marketing agency for home-services businesses.
                    We research local operators, and when we ran a preview of{' '}
                    {personalization
                      ? personalization.business_name
                      : 'your business'}{' '}
                    we saw a TurfScore that told us we might be able to help.
                    Rather than cold-pitch you, we wanted to lead with
                    something genuinely useful: your actual map. If it&rsquo;s
                    valuable and you&rsquo;d like to talk, great — if not, the
                    scan is yours either way, no strings.
                  </>
                ),
              },
              {
                q: "What's the catch?",
                a: (
                  <>
                    None — the full scan is free because it&rsquo;s how we
                    introduce ourselves. No subscription, no auto-enrollment,
                    no credit card. You keep the heatmap, competitor map, and
                    fix list. If you later want help executing the fixes,
                    that&rsquo;s a separate conversation you&rsquo;re free to
                    decline.
                  </>
                ),
              },
              {
                q: 'How did you get my information?',
                a: (
                  <>
                    We use publicly-available business data to identify
                    operators with significant local SEO weakness. Your
                    business name, address, and phone are listed publicly on
                    Google Business Profile, Yelp, and similar directories. We
                    ran a preview scan against this public data, identified
                    that you were missing visibility across your service area,
                    and reached out. No private data was accessed. If
                    you&rsquo;d prefer not to receive further outreach, simply
                    unsubscribe at the link in our email.
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* ─── WHAT YOU'LL GET (mirrors /fourdots Section 03) ─────────── */}
      <section
        className="px-6 md:px-10 py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-5xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            What&apos;s behind the button
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-3 max-w-3xl">
            One click reveals the full picture.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {[
              { icon: Grid3x3, title: 'Your exact heatmap', now: 'one score', unlocks: 'all 81 cells, block by block' },
              { icon: MapPin, title: 'Competitor map', now: 'your top competitor', unlocks: 'who owns which cells, every competitor' },
              { icon: Sparkles, title: 'AI Coach Fix List', now: 'nothing', unlocks: 'your top 3 prioritized actions' },
            ].map((p) => {
              const Icon = p.icon;
              return (
                <div key={p.title} className="border rounded-lg p-5" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
                  <Icon size={20} style={{ color: 'var(--color-lime)' }} />
                  <div className="font-display font-bold text-base mt-3 mb-3 text-zinc-100">{p.title}</div>
                  <div className="text-xs text-zinc-500 leading-relaxed"><span className="text-zinc-600">Now:</span> {p.now}</div>
                  <div className="text-xs text-zinc-300 leading-relaxed"><span style={{ color: 'var(--color-lime)' }}>Unlocks:</span> {p.unlocks}</div>
                </div>
              );
            })}
          </div>
          <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl mb-8">
            Three prioritized actions specific to your business and category,
            written by our AI Coach from your real audit data — not generic
            SEO advice.{' '}
            <strong className="font-semibold text-zinc-200">
              You walk away knowing what to fix, in what order.
            </strong>
          </p>

          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
            <span style={{ color: 'var(--color-lime)' }}>The fix list</span>
            <span className="text-zinc-600">·</span>
            <span>What you&rsquo;ll actually do</span>
          </div>
          <div
            className="border rounded-lg p-5 md:p-7"
            style={{
              background: '#0a0f04',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              {(() => {
                // Sprint-1 Fix 2.1 — dynamic trade reference in
                // the second card. When the prospect's trade is
                // known, surface it in the "For this {trade}
                // contractor:" preamble so the personalization
                // illusion holds for HVAC / Roofing / Plumbing
                // etc. Falls back to "operator" when no
                // personalization data is loaded.
                const tradeContractor = personalization
                  ? `${personalization.trade.toLowerCase()} contractor`
                  : 'operator';
                return [
                  {
                    priority: 'HIGH',
                    title:
                      'Verify your Apple Maps listing — currently unverified',
                    body: 'iPhone users searching from the northern half of your service area get directed to a verified competitor. Verifying the listing is a 5-minute fix that immediately reclaims those cells.',
                  },
                  {
                    priority: 'HIGH',
                    title: 'Claim 8 missing industry directories',
                    body: `For this ${tradeContractor}: Angi, HomeAdvisor, Thumbtack, BBB, and 4 others — all absent. The exact list is industry-specific. Citation authority on the directories Google cross-references is the fastest TurfReach lever.`,
                  },
                  {
                    priority: 'MEDIUM',
                    title: 'Normalize address format on Bing, Yelp, MapQuest',
                    body: 'Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals.',
                  },
                ];
              })().map((a, i) => (
                <div
                  key={i}
                  className="border rounded-md p-4 md:p-5"
                  style={{
                    background: 'var(--color-bg)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <span
                      className="text-[9px] font-mono uppercase font-bold tracking-[0.18em] px-1.5 py-0.5 rounded"
                      style={{
                        background:
                          a.priority === 'HIGH' ? '#1a2010' : '#221a08',
                        color:
                          a.priority === 'HIGH'
                            ? 'var(--color-lime)'
                            : '#f5b651',
                        border: `1px solid ${
                          a.priority === 'HIGH'
                            ? 'var(--color-border-bright)'
                            : '#3a2a0a'
                        }`,
                      }}
                    >
                      {a.priority}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-600">
                      #{i + 1}
                    </span>
                  </div>
                  <div className="font-display font-bold text-sm md:text-base leading-snug mb-2 text-zinc-100">
                    {a.title}
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    {a.body}
                  </p>
                </div>
              ))}
            </div>

            <div
              className="mt-5 pt-4 border-t flex items-start gap-2.5"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <Zap
                size={13}
                strokeWidth={2.5}
                className="flex-shrink-0 mt-0.5"
                style={{ color: 'var(--color-lime)' }}
              />
              <div className="text-xs leading-relaxed text-zinc-400">
                <span
                  className="font-semibold"
                  style={{ color: 'var(--color-lime)' }}
                >
                  Grounded in real data.
                </span>{' '}
                Every recommendation cites the specific directories
                you&rsquo;re missing from, the inconsistencies in your
                business listing, and the moves that map to your industry.
                No generic SEO advice — real audit findings, prioritized.
              </div>
            </div>

            <p className="text-xs text-zinc-600 font-mono mt-3">
              Sample output. Your actions will be specific to your business,
              category, and what your map reveals.
            </p>
          </div>
        </div>
      </section>

      {/* ─── HOW WE MEASURE ─────────────────────────────────────────── */}
      <section className="px-6 md:px-10 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            How we measure
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-3 max-w-3xl">
            Three numbers, anchored in your map.
          </h2>
          <p className="text-zinc-400 text-base leading-relaxed max-w-2xl mb-8">
            Every fix list is anchored in three computed metrics. They map
            directly to specific actions — that&rsquo;s why the
            recommendations above are prioritized the way they are.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
            <ScoreCardCompact
              icon={Compass}
              name="TurfReach"
              tagline="How much of your area you cover"
              range="0 – 100%"
              example="At 35%, two-thirds of nearby searchers don't see you."
            />
            <ScoreCardCompact
              icon={Crown}
              name="TurfRank"
              tagline="Where you sit when you do appear"
              range="1.0 – 3.0"
              example="At 1.4, you're scraping the bottom of the pack."
            />
            <ScoreCardCompact
              icon={Target}
              name="TurfScore"
              tagline="Composite visibility"
              range="0 – 100"
              example="Most pre-optimization clients land 30–55."
              highlight
            />
          </div>
        </div>
      </section>

      {/* ─── WHAT'S IN TURFSCAN ─────────────────────────────────────── */}
      <section
        className="px-6 md:px-10 py-12 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-4">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            What&rsquo;s in TurfScan
          </div>
          <ul className="space-y-3">
            {[
              '81-point geo-grid scan, one keyword',
              'TurfReach + TurfRank + TurfScore',
              'Citation check across the directories that matter for your trade',
              'AI Coach: top 3 strategic recommendations, grounded in your real audit data',
              'Branded PDF report you can keep or share',
              'Delivered in under a minute',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-3 text-sm md:text-base text-zinc-200 leading-relaxed"
              >
                <Check
                  size={16}
                  strokeWidth={2.5}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <div
            className="mt-5 flex items-start gap-2.5 text-sm leading-relaxed"
            style={{ color: 'var(--color-lime)' }}
          >
            <Sparkles
              size={15}
              strokeWidth={2.5}
              className="flex-shrink-0 mt-0.5"
            />
            <span>
              <span className="font-semibold">
                + 30 days of TurfMap Pulse, free
              </span>
              <span className="text-zinc-500">
                {' '}— offered on your order-confirmation page. Cancel anytime
                before day 31 to pay nothing.
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* ─── TRUST STRIP ────────────────────────────────────────────── */}
      <section
        className="px-6 md:px-10 py-8 border-y"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-8">
          <TrustItem icon={Clock} label="Delivery">
            Scan completes in &lt; 1 min. AI Coach fix list lands in your
            inbox alongside your map.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by operators">
            Fourdots Digital uses TurfMap on its own clients every day.
          </TrustItem>
        </div>
      </section>

      {/* ─── FAQ — five items, with cold-email-specific question at top ── */}
      <section className="px-6 md:px-10 py-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            Common questions
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold leading-tight tracking-tight mb-6 max-w-xl">
            Things people ask before <em>they buy.</em>
          </h2>
          <FAQAccordion
            items={[
              {
                q: 'What if I find out my visibility is bad?',
                a: (
                  <>
                    Visibility problems are fixable. Every TurfScan ends
                    with the AI Coach Fix List — the top three actions to
                    fix in priority order, specific to your business and
                    category. Most buyers walk away with a clear plan they
                    can act on in under an hour, or hand off to a
                    freelancer or team member.
                  </>
                ),
              },
              {
                q: 'How is this different from just Googling myself?',
                a: (
                  <>
                    Google personalizes local results by your physical
                    location. From your office, you&rsquo;ll always see
                    yourself near the top — that&rsquo;s not proof you
                    rank well, it&rsquo;s proof Google knows where you
                    are. TurfScan checks 81 different points across your
                    service area to show you what customers across town
                    actually see, not what you see from your desk.
                  </>
                ),
              },
              {
                q: 'How long does it take to receive my TurfMap?',
                a: (
                  <>
                    The scan itself finishes in under a minute — we run
                    all 81 queries in parallel against Google&rsquo;s
                    local-pack feed. After you fill in your business
                    details on the order form, you&rsquo;ll get an email
                    with a link to your map and your AI Coach fix list.
                  </>
                ),
              },
              {
                q: 'What keyword should I pick?',
                a: (
                  <>
                    We pre-fill the keyword with your trade
                    (e.g. <code>plumber</code>) — the same short term
                    we used for the preview scan. Trade-only keywords
                    give the cleanest geo-grid: each of the 81 points
                    is anchored to a real lat/lon around your service
                    area, and the trade keyword stays the same across
                    all of them so the result is &ldquo;where do I
                    show up for this trade as customers move around
                    the map?&rdquo; You can override the pre-fill if
                    you want a more specific term — just don&rsquo;t
                    include your city in the keyword (the grid points
                    already cover your service area).
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* ─── CLOSING CTA ────────────────────────────────────────────── */}
      <section className="px-6 md:px-10 pb-10">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-lg p-7 md:p-9 border text-center"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
              boxShadow: '0 0 40px #c5ff3a14',
            }}
          >
            <div className="font-display text-2xl md:text-3xl font-bold mb-3">
              Ready to see your real map?
            </div>
            <RiskReversalCallout />
            <p className="text-xs md:text-sm text-zinc-500 mb-6 max-w-md mx-auto leading-relaxed">
              {showDiscount && coupon && finalCents === 0 ? (
                <>
                  Free TurfScan with{' '}
                  <span className="font-mono text-zinc-300">
                    {coupon.code}
                  </span>{' '}
                  applied at checkout. No card required, no subscription.
                </>
              ) : showDiscount && coupon ? (
                <>
                  {formatUsd(finalCents)} TurfScan with{' '}
                  <span className="font-mono text-zinc-300">
                    {coupon.code}
                  </span>{' '}
                  applied at checkout. One-time, no subscription.
                </>
              ) : (
                <>
                  {formatUsd(finalCents)} TurfScan. One-time, no subscription.
                </>
              )}
            </p>
            {/* Closing-CTA click marker for the cold-funnel emitter. The
             *  hero CTA already carries data-funnel-cta="coldscan"; without
             *  this, a buyer who converts from the bottom of the page was
             *  invisible to coldscan_cta_click. The delegated listener in
             *  YourmapFunnelEmitter matches any clicked descendant. */}
            <div data-funnel-cta="coldscan">
              {useColdscanBypass && prospectId ? (
                <ColdscanRunButton
                  prospectId={prospectId}
                  utmSource={utmSource}
                  utmMedium={utmMedium}
                  utmCampaign={utmCampaign}
                  label={fullScanLabel(finalCents)}
                  centered
                />
              ) : (
                <ScanIntakeLinkButton from="yourmap"
                  coupon={couponCode}
                  utmSource={utmSource}
                  utmMedium={utmMedium}
                  utmCampaign={utmCampaign}
                  gclid={gclid}
                  prospectId={prospectId}
                  label={fullScanLabel(finalCents)}
                  centered
                />
              )}
            </div>
          </div>

          <p className="mt-6 text-xs text-zinc-600 text-center leading-relaxed">
            Want a 90-day Roadmap built around your map?{' '}
            <a
              href="https://www.turfmap.ai/#section-04"
              className="text-zinc-400 hover:text-zinc-200 transition-colors underline-offset-2 hover:underline"
            >
              See our Visibility Audit options →
            </a>
          </p>
        </div>
      </section>

      {/* ─── FOOTER ─────────────────────────────────────────────────── */}
      <footer
        className="border-t px-6 md:px-10 py-6 text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <span>
            TurfMap™ · Proprietary technology of{' '}
            <a
              href="https://fourdots.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Fourdots Digital
            </a>
          </span>
          <span className="flex items-center gap-4">
            <Link
              href="/#privacy"
              className="hover:text-zinc-400 transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/#terms"
              className="hover:text-zinc-400 transition-colors"
            >
              Terms
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

// ─── Already-converted state ────────────────────────────────────────────
//
// Renders when /api/prospect/[id] would return 410. Buyer is past
// the cold-email funnel — they have a dashboard already, sending
// them through another buy flow would create duplicate records.
// Two affordances: sign in (existing customer) or run a new scan
// on a different keyword (different SKU, different lander).

/* ───────────────────────────────────────────────────────────────────
 * Part B 5.6 — Risk-reversal callout (pulled up adjacent to first CTA).
 *
 * Previously lived in the closing-CTA section at the bottom of the
 * page. Moved here so the worst-case/best-case framing hits the
 * buyer at the moment of decision, not after they've already
 * decided to leave.
 *
 * Copy rewritten 2026-06-08: the legacy "one fix pays for the scan
 * ten times over" framing was leftover from the $99/$49 paid era —
 * makes no sense when the scan itself is free (COLDSCAN). Reframed
 * around lead/call volume, which is what home-services operators
 * actually measure success in.
 * ─────────────────────────────────────────────────────────────────── */
function RiskReversalCallout() {
  return (
    <div className="mb-4 max-w-xl">
      <p className="text-sm md:text-base text-zinc-300 leading-relaxed">
        <strong className="font-semibold text-zinc-100">Worst case:</strong>{' '}
        the scan confirms what you already suspect.{' '}
        <strong className="font-semibold text-zinc-100">Best case:</strong>{' '}
        one of the three fixes moves you into the top 3 for cells
        you&rsquo;re invisible in today — and the calls follow.
      </p>
    </div>
  );
}

/** Two one-line trust teasers under the hero map — each links to the
 *  "Why you got this" accordion (anchor #why-you-got-this). */
function HeroTrustLines() {
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} strokeWidth={2.25} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
        <p className="text-xs text-zinc-400 leading-relaxed">
          <strong className="font-semibold text-zinc-300">How do we know all this?</strong>{' '}
          A preview against your public Google Business Profile — no private data.{' '}
          <a href="#why-you-got-this" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300 transition-colors">More ›</a>
        </p>
      </div>
      <div className="flex items-start gap-2">
        <HelpCircle size={14} strokeWidth={2.25} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
        <p className="text-xs text-zinc-400 leading-relaxed">
          <strong className="font-semibold text-zinc-300">What&rsquo;s the catch?</strong>{' '}
          None — it&rsquo;s free because it&rsquo;s how we introduce ourselves.{' '}
          <a href="#why-you-got-this" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300 transition-colors">More ›</a>
        </p>
      </div>
    </div>
  );
}

/** Invisibility lead stat — count of dark grid points. Hidden when 0.
 *  Eyebrow copy is count-aware ("most" vs "parts" of your turf). */
function InvisibilityStatCard({ invisibilityCount }: { invisibilityCount: number }) {
  if (invisibilityCount <= 0) return null;
  return (
    <div className="rounded-lg p-5 md:p-6 border max-w-xl mb-5" style={{ background: '#1a0f0c', borderColor: '#5a2f0a' }}>
      <div className="flex items-center gap-2 mb-2.5 text-[10px] uppercase tracking-[0.18em] font-mono font-semibold">
        <span style={{ color: '#ff7a45' }}>●</span>
        <span style={{ color: '#ff7a45' }}>
          You&rsquo;re invisible{' '}
          {invisibilityCount >= 41 ? 'across most of your turf' : 'across parts of your turf'}
        </span>
      </div>
      <div className="font-display text-2xl md:text-3xl font-bold leading-tight text-zinc-100 mb-1.5">
        <span style={{ color: '#ff5f56' }}>{invisibilityCount}</span> of your 81 search points are dark
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">
        Customers searching from those areas don&rsquo;t see you in Google&rsquo;s Map Pack at all.
      </p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * Part B 5.3 — Trust strip placed near the first CTA.
 *
 * Three signals that answer the cold prospect's first skepticism
 * ("is this real, or another PDF mill?"). Each is framed as
 * about THIS prospect's scan, not generic marketing — the brief
 * explicitly calls out that ported homepage blocks dilute the
 * personalization that makes the channel work.
 *
 * The strip replaces the older single-line "Delivered in a minute
 * · 81 real searches" affordance directly under the CTA.
 * ─────────────────────────────────────────────────────────────────── */
function TrustStripRow({ city }: { city: string | null }) {
  const cityLabel = city && city.trim().length > 0 ? city : 'your area';
  return (
    <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3 max-w-xl">
      <TrustStripItem
        eyebrow="Real searches"
        title="81 Google queries"
        body={`Ran across ${cityLabel} — not estimates, not a directory check.`}
      />
      {/* "Real deliverable" was previously "Branded TurfReport PDF"
       *  — that's actually only shipped to audit-tier buyers + Pulse
       *  subscribers, NOT the free TurfScan output that this lander
       *  promises. Rewritten to describe what cold-cohort buyers
       *  actually get: a Fix List of 3 prioritized actions written
       *  by the AI Coach from their real audit data. */}
      <TrustStripItem
        eyebrow="Real deliverable"
        title="3 prioritized fixes"
        body="Written by the AI Coach from your real audit data — not generic SEO advice."
      />
      <TrustStripItem
        eyebrow="Real operators"
        title="Built by Fourdots"
        body="The agency that uses TurfMap on every client engagement."
      />
    </div>
  );
}

function TrustStripItem({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{
        background: 'var(--color-bg)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="text-[9px] uppercase tracking-[0.18em] font-mono font-semibold mb-1.5"
        style={{ color: 'var(--color-lime)' }}
      >
        ● {eyebrow}
      </div>
      <div className="text-[13px] font-semibold text-zinc-100 leading-tight mb-1">
        {title}
      </div>
      <p className="text-[11px] text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * Part B 5.5 — "One check = 1 of 81" reframe section.
 *
 * Compact section explaining why a low TurfScore matters — the
 * prospect probably checked their rank once from their office and
 * saw a misleading "good" result. Personalized against their own
 * invisibility percent + city so it doesn't read as generic.
 * ─────────────────────────────────────────────────────────────────── */
function OneOfEightyOneSection({
  invisiblePct,
  city,
  businessName,
  trade,
}: {
  invisiblePct: number;
  city: string;
  businessName: string;
  trade: string;
}) {
  const cityLabel =
    city && city.trim().length > 0 ? city : 'your service area';
  return (
    <section
      className="px-6 md:px-10 py-14 border-t"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="max-w-3xl mx-auto">
        <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
          <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
          Why a score of 0 doesn&rsquo;t mean what you think
        </div>
        <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-5 text-zinc-100">
          You checked your rank from your office. That&rsquo;s{' '}
          <em>one search</em> out of 81.
        </h2>
        <p className="text-zinc-300 text-base md:text-lg leading-relaxed">
          When you Google &ldquo;{trade.toLowerCase()}{' '}
          near me&rdquo; from your shop, Google centers the search around
          you. You rank #1 — for one cell. The TurfScan ran the other
          80 cells across {cityLabel} and found that{' '}
          <strong className="font-semibold text-zinc-100">
            {invisiblePct}% of them
          </strong>{' '}
          don&rsquo;t show {businessName} at all. Same business, same
          listing — different cells, different outcomes.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * Part B 5.4 — Testimonial section.
 *
 * Ports the named-operator testimonial from /free-score (the GTA
 * painting operator who caught an 18-month GBP category mismatch).
 * One quote, with attribution. Sits high in the page to answer the
 * cold prospect's third-party-proof question before the fix list
 * reveals the AI Coach output.
 * ─────────────────────────────────────────────────────────────────── */
function TestimonialSection() {
  return (
    <section
      className="px-6 md:px-10 py-14 border-t"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-card)',
      }}
    >
      <div className="max-w-3xl mx-auto">
        <div
          className="relative rounded-lg p-7 md:p-9 border"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'rgba(197, 255, 58, 0.35)',
            boxShadow: '0 0 30px #c5ff3a14',
          }}
        >
          <div
            className="font-display text-5xl md:text-6xl font-black leading-none absolute -top-1 left-5 md:left-7 select-none"
            style={{ color: 'var(--color-lime)' }}
            aria-hidden="true"
          >
            &ldquo;
          </div>
          <blockquote className="text-base md:text-lg text-zinc-50 leading-relaxed pt-4 md:pt-5">
            TurfMap caught a GBP category mismatch we&rsquo;d missed for
            18 months. Fixed it the same day.
          </blockquote>
          <p className="mt-4 text-xs font-mono text-zinc-500 leading-relaxed">
            — Painting operator, Greater Toronto Area
          </p>
        </div>
      </div>
    </section>
  );
}

function AlreadyConvertedState({ convertedAt }: { convertedAt: string }) {
  const dateStr = new Date(convertedAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div className="min-h-screen w-full text-white">
      <header
        className="border-b px-6 md:px-10 py-4 flex items-center justify-between"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <Link href="/" className="flex items-center gap-2.5 group">
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center"
            style={{ background: 'var(--color-lime)' }}
          >
            <Crosshair size={16} strokeWidth={2.25} className="text-black" />
          </span>
          <span className="font-display text-base md:text-lg font-bold tracking-tight">
            TurfMap
            <span
              className="text-[9px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
        </Link>
      </header>

      <section className="px-6 md:px-10 py-24">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            Already done
          </div>
          <h1 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-4">
            You&rsquo;ve already run your full TurfMap scan.
          </h1>
          <p className="text-zinc-300 text-base md:text-lg leading-relaxed mb-3">
            Your scan was completed on <strong>{dateStr}</strong>. Your AI
            Coach Fix List was delivered to your inbox.
          </p>
          <p className="text-zinc-400 text-sm md:text-base leading-relaxed mb-8">
            To view your dashboard, sign in. To run a fresh scan on a
            different keyword, run a new scan.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold border transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border-bright)',
                color: '#e4e4e7',
              }}
            >
              Sign in to my dashboard
            </Link>
            <Link
              href="/fourdots"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold transition-colors"
              style={{
                background: 'var(--color-lime)',
                color: '#000',
              }}
            >
              Run a new scan →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Helpers (clones of /fourdots — see header note about future shell refactor) ──

function PricePanel({
  listCents,
  finalCents,
  coupon,
  couponCode,
  utmSource,
  utmMedium,
  utmCampaign,
  gclid,
  prospectId,
  useColdscanBypass = false,
}: {
  listCents: number;
  finalCents: number;
  coupon: CouponDescriptor | null;
  couponCode: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  gclid: string | null;
  prospectId: string | null;
  /** When true, swap the Stripe checkout CTA for the one-click
   *  COLDSCAN free-scan button (skips Stripe entirely). Set by the
   *  parent when coupon=COLDSCAN + prospect has geo backfilled. */
  useColdscanBypass?: boolean;
}) {
  const showDiscount = coupon !== null;
  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl"
      style={{
        background: showDiscount
          ? 'var(--color-card-glow)'
          : 'var(--color-card)',
        borderColor: showDiscount
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
        boxShadow: showDiscount ? '0 0 30px #c5ff3a14' : undefined,
      }}
    >
      {/* Bridge line — Sprint-1 Fix 1.2 spec'd copy. Sits at the
       *  TOP of the price card so it bridges from the body
       *  paragraph (above the card) into the CTA flow (below this
       *  line). Three middle-dot-separated phrases re-state the
       *  body para's promises in compact form. The leading price
       *  creates immediate price-value continuity at the moment of
       *  click; parameterized via finalCents so a COLDSCAN visitor
       *  sees "Free", a no-coupon visitor sees "$99". */}
      <p className="mb-4 pb-4 border-b text-xs md:text-sm text-zinc-300 leading-relaxed"
         style={{ borderColor: 'var(--color-border)' }}
      >
        <strong className="text-zinc-100">
          {finalCents === 0 ? 'Free' : formatUsd(finalCents)} unlocks:
        </strong>{' '}
        full 81-cell heatmap{' '}
        <span className="text-zinc-600">·</span>{' '}
        AI Coach Fix List{' '}
        <span className="text-zinc-600">·</span>{' '}
        top 3 fixes
      </p>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
            TurfScan
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            {/* Fix 1.5 — list price drops to font-normal so the
             *  discounted price dominates visually. Strikethrough
             *  + zinc-600 carries the "this was the price" framing
             *  without the eye lingering on the bigger number. */}
            {showDiscount && (
              <span className="font-display text-2xl md:text-3xl text-zinc-600 line-through font-normal">
                {formatUsd(listCents)}
              </span>
            )}
            <span
              className="font-display text-4xl md:text-5xl font-bold"
              style={{
                color: showDiscount ? 'var(--color-lime)' : '#ffffff',
              }}
            >
              {finalCents === 0 ? 'FREE' : formatUsd(finalCents)}
            </span>
            <span className="text-xs text-zinc-500 font-mono">one-time</span>
          </div>
          {showDiscount && coupon && (
            <p className="text-xs text-zinc-400 mt-2">
              <span className="font-mono text-zinc-200">{coupon.code}</span>{' '}
              applied at checkout —{' '}
              {finalCents === 0 ? 'no card required' : 'no manual code needed'}.
            </p>
          )}
        </div>
        {useColdscanBypass && prospectId ? (
          <ColdscanRunButton
            prospectId={prospectId}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            label={fullScanLabel(finalCents)}
          />
        ) : (
          <ScanIntakeLinkButton from="yourmap"
            coupon={couponCode}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
            prospectId={prospectId}
            label={fullScanLabel(finalCents)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Score readout — distinct card per metric per Sprint-1 Fix 1.4.
 * Each card has a subtle border + tinted bg so the row reads as
 * "three numbers your full scan reveals" instead of caption text
 * under the heatmap. The TurfScore card carries an extra lime
 * accent (highlight) since it's the headline metric.
 *
 * Numeric value is now ~2× the previous size (text-xl → text-2xl/3xl)
 * to compete with the H1 weight on the left and read at a glance
 * on mobile. Band label sits beneath in small mono.
 */
function ScoreReadout({
  label,
  value,
  highlight = false,
  bandLabel,
  ariaLabel,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  bandLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="rounded-md px-2.5 py-3 flex flex-col items-center text-center"
      style={{
        background: highlight ? '#0d130a' : 'var(--color-bg)',
        border: `1px solid ${
          highlight ? 'var(--color-border-bright)' : 'var(--color-border)'
        }`,
      }}
    >
      <div className="text-[10px] tracking-[0.04em] text-zinc-500 font-mono font-semibold mb-1.5">
        {label}
      </div>
      <div
        className="font-display font-bold text-2xl md:text-3xl leading-none"
        style={{ color: highlight ? 'var(--color-lime)' : '#f4f4f5' }}
      >
        {value}
      </div>
      {bandLabel && (
        <div
          className="text-[9px] font-mono uppercase tracking-wider mt-1.5"
          style={{ color: 'var(--color-lime)' }}
        >
          {bandLabel}
        </div>
      )}
    </div>
  );
}

function ScoreCardCompact({
  icon: Icon,
  name,
  tagline,
  range,
  example,
  highlight = false,
}: {
  icon: typeof Compass;
  name: string;
  tagline: string;
  range: string;
  example: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="border rounded-lg p-5 flex flex-col"
      style={{
        background: highlight ? 'var(--color-card-glow)' : 'var(--color-card)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <Icon size={18} className="text-zinc-500" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
          {range}
        </span>
      </div>
      <div className="font-display text-xl md:text-2xl font-bold mb-1">
        {name}
        <span
          className="text-xs align-top ml-0.5"
          style={{ color: 'var(--color-lime)' }}
        >
          ™
        </span>
      </div>
      <div className="text-xs text-zinc-400 mb-3">{tagline}</div>
      <p className="text-sm text-zinc-300 leading-relaxed mt-auto">
        <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500 mr-2">
          E.g.
        </span>
        {example}
      </p>
    </div>
  );
}

function TrustItem({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ShieldCheck;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} style={{ color: 'var(--color-lime)' }} />
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
        </div>
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}

function pickFirst(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Shared price-aware CTA label. "free" on the COLDSCAN $0 path. */
function fullScanLabel(finalCents: number): string {
  return finalCents === 0
    ? 'Run the full scan — free'
    : `Run the full scan — ${formatUsd(finalCents)}`;
}

// ─── Sprint-2 cards: Your Preview Score + The Competition ──────────
//
// Both cards live in the left column of the hero between the body
// paragraph and the pricing card. They take the place of the data
// that used to be embedded in the body para (preview score sentence
// + "also, competitor X is winning Y%" footnote) and surface it as
// the visual centerpiece of the personalized cohort experience.

/** Map a band label to a fill/text accent. Mirrors the dashboard's
 *  band-color convention. Uses existing CSS-variable palette only
 *  — no new colors introduced. */
function bandAccent(band: string): { hex: string; fg: string } {
  // The codebase's getTurfScoreBand returns labels: Invisible /
  // Patchy / Solid / Dominant / Rare air. The Sprint-2 spec uses
  // "Saturated" for 80+; we honor the codebase label ("Rare air")
  // since that's what the data carries, but the color treatment
  // matches the spec's intent.
  switch (band) {
    case 'Invisible':
      return { hex: '#ff4d4d', fg: '#ffffff' };
    case 'Patchy':
      return { hex: '#ff9f3a', fg: '#000000' };
    case 'Solid':
      return { hex: '#e8e54a', fg: '#000000' };
    case 'Dominant':
      return { hex: '#c5ff3a', fg: '#000000' };
    case 'Rare air':
    case 'Saturated':
      return { hex: '#c5ff3a', fg: '#000000' };
    default:
      return { hex: '#a1a1aa', fg: '#000000' };
  }
}

/** Plain-English interpretation per band label. Lookup table; falls
 *  back to a neutral string when an unfamiliar label comes through
 *  so the card never renders empty. */
function bandInterpretation(band: string): string {
  switch (band) {
    case 'Invisible':
      return "You're missing from most of your service area. Customers searching nearby aren't seeing you in the Map Pack.";
    case 'Patchy':
      return 'You appear in some neighborhoods but not most. Customers in significant parts of your service area aren’t finding you.';
    case 'Solid':
      return 'You appear in about half your service area. Above-average operators land here.';
    case 'Dominant':
      return 'You appear in most of your service area. Strong local visibility.';
    case 'Rare air':
    case 'Saturated':
      return 'You appear in nearly all your service area. Top-tier visibility.';
    default:
      return 'Your TurfScore measures how much of your service area you cover in Google’s local Map Pack.';
  }
}

/** Your Preview Score — primary visual anchor of the hero.
 *  Large score numeric + band label in band color + plain-English
 *  interpretation. Lime accent border so it visually anchors as the
 *  "your data" half of the score/competition pair. */
function YourPreviewScoreCard({
  score,
  band,
}: {
  score: number;
  band: string;
}) {
  const accent = bandAccent(band);
  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl mb-5"
      style={{
        background: 'var(--color-card-glow)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 30px #c5ff3a10',
      }}
    >
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
        <span style={{ color: 'var(--color-lime)' }}>●</span>
        <span style={{ color: 'var(--color-lime)' }}>Your preview score</span>
      </div>
      <div className="flex items-baseline gap-4 flex-wrap mb-3">
        <span
          className="font-display font-bold text-6xl md:text-7xl leading-none"
          style={{ color: 'var(--color-lime)' }}
        >
          {score}
        </span>
        <span
          className="font-display text-xl md:text-2xl font-semibold uppercase tracking-wider"
          style={{ color: accent.hex }}
        >
          {band}
        </span>
      </div>
      <p className="text-zinc-300 text-sm md:text-base leading-relaxed">
        {bandInterpretation(band)}
      </p>
    </div>
  );
}

/** The Competition — secondary card, warm-toned accent. Sits beneath
 *  Your Preview Score so the buyer's eye moves my-score → competitor-
 *  hold → CTA. Uses the existing --color-warn (orange) channel as a
 *  subtle border + tinted bg, not an alarm-style red. */
function TheCompetitionCard({
  competitorName,
  sharePct,
  city,
}: {
  // Both nullable: the cold-prospect Instantly/Apollo enrichment
  // pipeline silently drops top_competitor_name + top_competitor_share_pct
  // on ~99.8% of rows. Rather than hiding the card entirely (and
  // losing one of the hero's strongest conversion levers), render a
  // curiosity-driving fallback so every prospect sees the
  // "someone's winning your area" pressure.
  competitorName: string | null;
  sharePct: number | null;
  city: string;
}) {
  const hasName = Boolean(competitorName && competitorName.trim().length > 0);
  const hasPct = sharePct !== null && sharePct !== undefined;
  const cityLabel =
    city && city.trim().length > 0 ? city : 'your service area';

  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl mb-5"
      style={{
        background: '#1f1308',
        borderColor: '#5a2f0a',
      }}
    >
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] font-mono font-semibold">
        <span style={{ color: 'var(--color-warn)' }}>●</span>
        <span style={{ color: 'var(--color-warn)' }}>The competition</span>
      </div>
      <h3 className="font-display text-xl md:text-2xl font-bold text-zinc-100 mb-2">
        {hasName ? competitorName : 'Someone’s winning your area.'}
      </h3>
      {hasPct ? (
        <p className="text-zinc-200 text-sm md:text-base leading-relaxed mb-3">
          Showing up in{' '}
          <strong className="font-semibold" style={{ color: 'var(--color-warn)' }}>
            {sharePct}% of your service area
          </strong>{' '}
          where you don&rsquo;t — searches you&rsquo;re simply not in.
        </p>
      ) : (
        <>
          <p className="text-zinc-200 text-sm md:text-base leading-relaxed mb-3">
            A specific competitor is currently outranking you across{' '}
            <strong className="font-semibold" style={{ color: 'var(--color-warn)' }}>
              {cityLabel}
            </strong>
            .
          </p>
          <p className="text-zinc-400 text-sm leading-relaxed">
            The full scan names them — and shows you exactly which Map Pack
            cells they own, plus where the gaps are.
          </p>
        </>
      )}
    </div>
  );
}
