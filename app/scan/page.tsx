import type { Metadata } from 'next';
import Image from 'next/image';
import {
  Check,
  Compass,
  Crosshair,
  Crown,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
  ChevronDown,
} from 'lucide-react';
import { HeatmapAnimateOnView } from '@/components/marketing/scan/HeatmapAnimateOnView';
import { ScanCheckoutButton } from '@/components/marketing/ScanCheckoutButton';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { buildHeroCells } from '@/components/marketing/heroSeed';
import { ExpiryCountdown } from '@/components/marketing/scan/ExpiryCountdown';
import { StickyCheckoutBar } from '@/components/marketing/scan/StickyCheckoutBar';
import { MetaPixelScrollDepth } from '@/components/marketing/scan/MetaPixel';

/**
 * Cold-Meta paid-traffic landing page (/scan).
 *
 * Distinct from /yourmap (cold-email, personalized by prospect_id) and
 * /fourdots (exit-intent popup on fourdots.io). /scan receives anonymous
 * Meta-ad clicks and sells the $49 TurfScan via MAPCHECK50, with the
 * existing 1-click upsell to the $197 Visibility Audit firing on the
 * standard /order/success post-checkout path.
 *
 * Mobile-first vertical stack — ~70% of expected Meta traffic is mobile
 * per category benchmarks. Layout: 10 sequential sections, each ~1-1.5
 * mobile viewport heights, with a CTA cadence of roughly every 2
 * sections. A sticky bottom CTA bar appears on mobile after the buyer
 * scrolls past the hero.
 *
 * URL contract:
 *   /scan                            — bare visit; MAPCHECK50 still
 *                                      auto-applies at checkout because
 *                                      the page hardcodes it on the CTAs
 *                                      (independent of any URL param).
 *   /scan?utm_source=meta&utm_*=...  — Meta-ad attribution; forwarded
 *                                      to Stripe metadata for funnel
 *                                      attribution downstream.
 *
 * Urgency mechanic:
 *   First /scan visit sets a `mapcheck50_arrival` cookie (24h max-age).
 *   The hero + final-CTA countdowns read from that cookie and decrement
 *   live until expiry. v1 is cookie-only — Stripe-side expiry enforcement
 *   is deferred. See ExpiryCountdown for the trade-off rationale.
 *
 * Meta pixel:
 *   - PageView fires automatically via MetaPixelBase in app/layout.
 *   - ViewContent fires at 50% scroll depth (engagement signal).
 *   - InitiateCheckout fires on any ScanCheckoutButton click via the
 *     button's built-in fbq hook.
 *   - Purchase fires on /order/success when amount_total resolves.
 *   All events gated on NEXT_PUBLIC_META_PIXEL_ID — no-op when unset.
 */

export const metadata: Metadata = {
  title: 'Get your $49 TurfScan — TurfMap',
  description:
    "See exactly where you rank across your service area. 81-point geo-grid scan + AI Coach fix list, delivered in under a minute. $99 → $49 with code MAPCHECK50.",
  // Paid-traffic LP — not a canonical entry point. Don't compete
  // with / for brand keywords or bleed into organic results.
  robots: { index: false, follow: false },
};

// Fixed coupon — /scan is a single-purpose cold-Meta lander. MAPCHECK50
// is hardcoded into every CTA; the URL is not consulted for coupon
// overrides (unlike /yourmap which respects ?coupon=). Keeps the
// checkout payload deterministic for Meta-attribution debugging.
const SCAN_COUPON = 'MAPCHECK50';
const DEFAULT_UTM_SOURCE = 'meta_cold';
const DEFAULT_UTM_MEDIUM = 'paid_social';

const LIST_CENTS = 9900;
const FINAL_CENTS = 4900;
const fmt = (cents: number) => `$${cents / 100}`;

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

export default async function ScanLandingPage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const utmSource = pickFirst(params.utm_source) ?? DEFAULT_UTM_SOURCE;
  const utmMedium = pickFirst(params.utm_medium) ?? DEFAULT_UTM_MEDIUM;
  const utmCampaign = pickFirst(params.utm_campaign);
  const gclid = pickFirst(params.gclid);

  const cells = buildHeroCells();

  // Section anchor passed to a few primary CTAs so they can scroll
  // back to the hero on click if the buyer wants to verify the price
  // before committing. Currently unused — kept for parity with the
  // other landers' patterns.

  return (
    <div className="min-h-screen w-full text-white">
      {/* Mobile sticky bottom checkout bar — appears after scroll past hero. */}
      <StickyCheckoutBar
        coupon={SCAN_COUPON}
        utmSource={utmSource}
        utmMedium={utmMedium}
        utmCampaign={utmCampaign}
      />

      {/* Meta pixel engagement signal — fires at 50% scroll depth. */}
      <MetaPixelScrollDepth percent={50} event="ViewContent" />

      {/* ─── Top nav strip ───────────────────────────────────────────
       *  Brand mark only. No sign-in link — /scan is a cold-Meta paid
       *  lander; existing customers don't arrive here, and an exit
       *  affordance pulls focus away from the single buy decision. */}
      <nav
        className="border-b px-4 md:px-6 py-3 flex items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 16px #c5ff3a30',
            }}
          >
            <Crosshair size={14} className="text-black" strokeWidth={2.75} />
          </div>
          <span className="font-display text-base font-bold">TurfMap.ai</span>
        </div>
      </nav>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 01 — Hero                                                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="px-5 md:px-8 pt-8 pb-10 md:pt-14 md:pb-16">
        <div className="max-w-2xl mx-auto text-center md:text-left">
          {/* Eyebrow — lime accent, single line on mobile */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-5"
            style={{ color: 'var(--color-lime)' }}
          >
            Google Maps audit · 60 seconds · $49 with code MAPCHECK50
          </div>

          {/* H1 — 32-36px on mobile per brief */}
          <h1 className="font-display text-[32px] md:text-5xl font-black leading-[1.1] tracking-tight mb-5 text-zinc-50">
            Find every Google Maps cell where your competitors are stealing
            your traffic.
          </h1>

          {/* Subhead — two short sentences, "two-thirds" bold-emphasized */}
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-6 max-w-xl mx-auto md:mx-0">
            Most local businesses are invisible in{' '}
            <strong className="font-bold text-zinc-100">two-thirds</strong>{' '}
            of their own service area.{' '}
            <span className="block mt-3">
              Before you hire an SEO agency or spend another dollar on local
              marketing, see exactly where you&apos;re losing — and what to fix
              first.
            </span>
          </p>

          {/* Price callout — list strikethrough + final price + coupon */}
          <div className="mb-3 flex items-baseline justify-center md:justify-start gap-3 flex-wrap">
            <span className="font-display text-2xl md:text-3xl text-zinc-600 line-through font-normal">
              {fmt(LIST_CENTS)}
            </span>
            <span
              className="font-display text-4xl md:text-5xl font-black"
              style={{ color: 'var(--color-lime)' }}
            >
              {fmt(FINAL_CENTS)}
            </span>
            <span className="text-xs md:text-sm text-zinc-400 font-mono">
              with code MAPCHECK50
            </span>
          </div>

          {/* Live countdown — reads/writes the mapcheck50_arrival cookie */}
          <div className="mb-7">
            <ExpiryCountdown className="text-xs font-mono text-zinc-500" />
          </div>

          {/* Primary CTA — full-width on mobile, large tap target */}
          <ScanCheckoutButton
            coupon={SCAN_COUPON}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
            label="Run my scan — $49 with MAPCHECK50"
            centered
          />

          {/* Sentinel for StickyCheckoutBar's IntersectionObserver. When
           *  this element scrolls off-screen, the mobile sticky bar
           *  slides up; when it scrolls back into view, the sticky slides
           *  down. */}
          <div id="scan-sticky-sentinel" aria-hidden="true" />

          {/* Trust strip — three short items separated by middle dots */}
          <p className="text-xs text-zinc-500 mt-5 leading-relaxed">
            60-second delivery
            <span className="text-zinc-700 mx-2">·</span>
            No subscription
            <span className="text-zinc-700 mx-2">·</span>
            Full refund within 24h
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 02 — Visual proof (sample TurfMap)                              */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-14 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, transparent 0%, var(--color-card) 100%)',
        }}
      >
        <div className="max-w-md mx-auto">
          <div
            className="rounded-lg border p-4 md:p-6"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
            }}
          >
            {/* Outside-in animated reveal on scroll into view — the
             *  grid IS the credibility element on this lander, so we
             *  defer the cell-by-cell reveal until the buyer is actually
             *  looking at it. ~1.6s total animation (200ms/dist * ~5.66
             *  max dist = ~1.1s stagger + 220ms cell fade per the
             *  HeatmapGrid transition). Reduced-motion preference is
             *  honored inside HeatmapGrid → static end state. */}
            <HeatmapAnimateOnView cells={cells} />
          </div>
          <p className="text-xs md:text-sm text-zinc-400 leading-relaxed mt-5 text-center">
            <strong className="font-semibold text-zinc-200">
              Sample TurfMap scan:
            </strong>{' '}
            HVAC operator, suburban Toronto.
            <br />
            This operator is visible in 18 of 81 cells (TurfScore 22).
          </p>

          <div className="mt-6">
            <ScanCheckoutButton
              coupon={SCAN_COUPON}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              label="Run mine — $49"
              centered
              // No helper text — the hero CTA one screen above already
              // spelled out the click-flow; repeating it dilutes the
              // visual hierarchy on this short reassurance section.
              helperText={null}
            />
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 03 — The problem                                                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            The problem
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-tight tracking-tight mb-6 text-zinc-50">
            You checked your rank{' '}
            <em className="not-italic underline decoration-2 underline-offset-4 decoration-zinc-600">
              once.
            </em>{' '}
            From your office.
            <br />
            That&rsquo;s one search out of 81.
          </h2>
          <div className="space-y-4 text-base text-zinc-300 leading-relaxed">
            <p>
              Google personalizes local results by where the searcher is
              standing. Someone across town sees a completely different Map
              Pack than someone next door to you.
            </p>
            <p>
              That means a single rank check from your laptop tells you almost
              nothing about where your real customers can actually find you.
            </p>
            <p>
              Most operators discover this after months of paying for SEO that
              &ldquo;improved rankings&rdquo; — while their phone keeps not
              ringing.
            </p>
          </div>

          {/* Stacked comparison cards — single column on mobile */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
            <div
              className="rounded-lg border p-5"
              style={{
                background: '#15151b',
                borderColor: 'var(--color-border)',
              }}
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
                One number
              </div>
              <div className="font-display text-base font-bold text-zinc-200 mb-2">
                What most rank trackers tell you
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                <span className="font-mono text-zinc-300">
                  &ldquo;You rank #2 for plumber Toronto.&rdquo;
                </span>{' '}
                Useful only if every customer searches from the same point.
              </p>
            </div>
            <div
              className="rounded-lg border p-5"
              style={{
                background: 'var(--color-card-glow)',
                borderColor: 'var(--color-border-bright)',
                boxShadow: '0 0 30px #c5ff3a14',
              }}
            >
              <div
                className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold mb-2"
                style={{ color: 'var(--color-lime)' }}
              >
                81 cells
              </div>
              <div className="font-display text-base font-bold text-zinc-100 mb-2">
                What TurfMap tells you
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed">
                <span className="font-mono text-zinc-100">
                  &ldquo;You rank #1 in 12 cells, #2 in 14, #3 in 11, invisible
                  in 44.&rdquo;
                </span>{' '}
                Now you know the shape of your territory.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 04 — What you get + dollar anchor                               */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, var(--color-card) 0%, transparent 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            What you get
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-tight tracking-tight mb-8 text-zinc-50">
            A 60-second scan, a personalized fix list, and a strategist-grade
            PDF report.
          </h2>

          {/* Four deliverables — stacked on mobile */}
          <div className="space-y-4 mb-8">
            <DeliverableCard
              icon={Target}
              title="81-point geo-grid scan across your service area"
              body="See every cell where you appear or disappear in Google's Map Pack."
            />
            <DeliverableCard
              icon={Compass}
              title="TurfReach + TurfRank + TurfScore metrics"
              body="Three proprietary numbers that map directly to action."
            />
            <DeliverableCard
              icon={Sparkles}
              title="AI Coach Fix List"
              body="Three prioritized actions, named directories, specific fixes — written from your real audit data."
            />
            <DeliverableCard
              icon={Crown}
              title="Branded PDF report"
              body="Keep it, share it, hand it to a freelancer, or use it to evaluate marketing vendors."
            />
          </div>

          {/* Dollar anchor — agency comp vs list vs final */}
          <div
            className="rounded-lg border p-5 md:p-6"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500 mb-3">
              Comparable value
            </div>
            <div className="space-y-2 text-sm md:text-base">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-zinc-300">
                  Equivalent agency audit work
                </span>
                <span className="font-display font-bold text-zinc-200">
                  $1,500–$2,500
                </span>
              </div>
              <div className="text-xs text-zinc-500 leading-relaxed pb-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
                Most agencies charge this before they&rsquo;ll even look at
                your map pack.
              </div>
              <div className="flex items-baseline justify-between gap-4 pt-1">
                <span className="text-zinc-400">TurfScan list price</span>
                <span className="font-display font-bold text-zinc-500 line-through">
                  {fmt(LIST_CENTS)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-zinc-100 font-semibold">
                  Today with MAPCHECK50
                </span>
                <span
                  className="font-display text-2xl font-black"
                  style={{ color: 'var(--color-lime)' }}
                >
                  {fmt(FINAL_CENTS)}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-8">
            <ScanCheckoutButton
              coupon={SCAN_COUPON}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              label="Run my scan — $49 with MAPCHECK50"
              centered
              // Section 04 dollar-anchor CTA — vary the helper to add
              // incremental information (refund window) rather than
              // repeat the hero's click-flow line.
              helperText="$49 charged once. Refund within 24h if unsatisfied."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 05 — Sample fix list                                            */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            Real audit findings — not generic SEO advice
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-tight tracking-tight mb-8 text-zinc-50">
            Here&rsquo;s an example of what your fix list will look like.
          </h2>

          <div className="space-y-4">
            <FixItem
              priority="HIGH"
              number={1}
              title="Verify your Apple Maps listing — currently unverified"
              body="iPhone users searching from the northern half of your service area get directed to a verified competitor. Verifying the listing is a 5-minute fix that immediately reclaims those cells."
            />
            <FixItem
              priority="HIGH"
              number={2}
              title="Claim 8 missing industry directories"
              body="For this HVAC operator: Angi, HomeAdvisor, Thumbtack, BBB, and 4 others — all absent. The exact list is industry-specific. Citation authority on the directories Google cross-references is the fastest TurfReach lever."
            />
            <FixItem
              priority="MEDIUM"
              number={3}
              title="Normalize address format on Bing, Yelp, MapQuest"
              body="Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals."
            />
          </div>

          <p className="text-xs text-zinc-500 mt-6 leading-relaxed">
            Sample output. Your fix list will be specific to your business,
            category, and what your scan reveals.
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 06 — Why this is real                                           */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, transparent 0%, var(--color-card) 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-6"
            style={{ color: 'var(--color-lime)' }}
          >
            Why this is real software, not a PDF mill
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ProofCard
              title="81 actual searches"
              body="Real queries against Google's local-pack feed, run in parallel. Not estimates. Not scrapes. Not your competitor's average."
            />
            <ProofCard
              title="Personalized to your business"
              body="The fix list cites your specific directories, your specific inconsistencies, your specific trade — all pulled from your real audit data."
            />
            <ProofCard
              title="Built and used by an agency"
              body="TurfMap is proprietary technology of Fourdots Digital, a Toronto agency. We use it on every client engagement. Then we made it available direct to operators."
            />
          </div>

          <div className="mt-8">
            <ScanCheckoutButton
              coupon={SCAN_COUPON}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              label="Run my scan — $49 with MAPCHECK50"
              centered
              // Section 06 proof-cards CTA — vary the helper to spotlight
              // delivery speed (concrete operational fact, not a repeat
              // of the hero's click-flow line).
              helperText="60-second delivery to your inbox."
            />
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 07 — Founder / agency credibility                               */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            About TurfMap
          </div>

          {/* Photo + heading row.
           *  Mobile: photo stacked above the heading (per brief).
           *  Desktop (md+): photo on the left, heading + body on the
           *  right, vertically aligned with the heading. Photo sized
           *  ~80px on mobile and ~112px on desktop. */}
          <div className="flex flex-col md:flex-row md:items-start md:gap-6 mb-6">
            <div className="mb-4 md:mb-0 flex-shrink-0">
              <Image
                src="https://fourdots.io/assets/proof/anthony-headshot.png"
                alt="Anthony Alfonsi, Founder & Director, Fourdots Digital"
                width={112}
                height={112}
                className="rounded-full w-20 h-20 md:w-28 md:h-28 object-cover border"
                style={{
                  borderColor: 'var(--color-border-bright)',
                }}
              />
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-black leading-tight tracking-tight text-zinc-50">
              We built TurfMap because the tools we were using weren&rsquo;t
              telling us enough.
            </h2>
          </div>

          <div className="space-y-4 text-base text-zinc-300 leading-relaxed">
            <p>
              TurfMap is proprietary technology of Fourdots Digital, a
              Toronto-based agency that&rsquo;s been running paid traffic and
              local SEO for home service operators since 2019.
            </p>
            <p>
              We use TurfMap on every client engagement — before we recommend a
              single change, before we touch an ad campaign, before we publish
              a single piece of content. Because the data tells us where to
              focus. It&rsquo;s what helped a national painting franchise go
              from 62 booked calls to 671 in one month — same budget, same
              business.
            </p>
            <p>
              We made TurfScan available direct because operators kept asking
              how they could see what we see. Now you can.
            </p>
          </div>

          {/* Founder attribution line — pairs the photo with a name */}
          <p className="mt-5 text-xs font-mono text-zinc-500">
            — Anthony Alfonsi, Founder &amp; Director, Fourdots Digital
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 08 — Money-back guarantee                                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-14 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="rounded-lg p-6 md:p-8 border-2 text-center md:text-left"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-lime)',
            }}
          >
            <div className="flex items-center justify-center md:justify-start gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{
                  background: 'var(--color-lime)',
                  boxShadow: '0 0 24px #c5ff3a40',
                }}
              >
                <ShieldCheck
                  size={20}
                  className="text-black"
                  strokeWidth={2.5}
                />
              </div>
              <h3 className="font-display text-xl md:text-2xl font-black text-zinc-50">
                Refund in one email.
              </h3>
            </div>
            <p className="text-sm md:text-base text-zinc-300 leading-relaxed">
              If your scan doesn&rsquo;t deliver within 60 minutes of purchase,
              or if the fix list doesn&rsquo;t feel like it&rsquo;s worth the
              $49 you paid, send us a one-line email at{' '}
              <span className="font-mono text-zinc-100">
                hello@turfmap.ai
              </span>{' '}
              within 24 hours and we&rsquo;ll refund the full charge.
              <br />
              No questions, no forms, no support tickets.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 09 — FAQ                                                        */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <h2 className="font-display text-2xl md:text-4xl font-black leading-tight tracking-tight mb-8 text-zinc-50">
            Common questions before you order.
          </h2>
          <FAQAccordion items={FAQ_ITEMS} />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 10 — Final CTA                                                  */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-12 md:py-20 border-t"
        style={{
          borderColor: 'var(--color-border-bright)',
          background:
            'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        }}
      >
        {/* Sentinel for StickyCheckoutBar — when this enters the
         *  viewport, the mobile sticky bar slides DOWN so the buyer
         *  isn't looking at two "Run my scan" CTAs simultaneously.
         *  See StickyCheckoutBar.tsx for the dual-observer logic. */}
        <div id="scan-final-cta-sentinel" aria-hidden="true" />
        <div className="max-w-2xl mx-auto text-center md:text-left">
          <h2 className="font-display text-3xl md:text-5xl font-black leading-tight tracking-tight mb-5 text-zinc-50">
            Find out what your map looks like.
          </h2>
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-7 max-w-xl mx-auto md:mx-0">
            If you made it to the bottom of this page, you already suspect
            you&rsquo;ve got a visibility problem. Worst case, $49 confirms
            it. Best case, you find a fix that pays for itself in one new
            customer.
          </p>
          <ScanCheckoutButton
            coupon={SCAN_COUPON}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
            label="Run my scan — $49 with MAPCHECK50"
            centered
          />
          <div className="mt-4 flex flex-col items-center md:items-start gap-2">
            <ExpiryCountdown className="text-xs font-mono text-zinc-500" />
          </div>
        </div>
      </section>

      {/* Bottom padding so the sticky CTA doesn't overlap the final
       *  section's content on mobile. ~80px ≥ sticky height + safe-area. */}
      <div className="h-20 md:hidden" />
    </div>
  );
}

// ─── Section helpers ────────────────────────────────────────────────────

function DeliverableCard({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded-lg border p-5 flex gap-3 items-start"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
        style={{
          background: '#0d130a',
          border: '1px solid var(--color-border-bright)',
        }}
      >
        <Check size={14} style={{ color: 'var(--color-lime)' }} strokeWidth={2.75} />
      </div>
      <div>
        <div className="font-display text-base font-bold text-zinc-100 mb-1">
          <span className="hidden">
            <Icon size={0} />
          </span>
          {title}
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function FixItem({
  priority,
  number,
  title,
  body,
}: {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  number: number;
  title: string;
  body: string;
}) {
  const priColor =
    priority === 'HIGH'
      ? '#ff4d4d'
      : priority === 'MEDIUM'
        ? '#ff9f3a'
        : '#a4a4a4';
  return (
    <div
      className="rounded-lg border p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span
          className="text-[10px] font-mono font-bold px-2 py-0.5 rounded uppercase tracking-wider"
          style={{ background: `${priColor}22`, color: priColor }}
        >
          {priority}
        </span>
        <span className="text-xs font-mono text-zinc-500">·</span>
        <span className="text-xs font-mono text-zinc-400">#{number}</span>
      </div>
      <div className="font-display text-base md:text-lg font-bold text-zinc-100 mb-2 leading-snug">
        {title}
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}

function ProofCard({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-lg border p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="font-display text-base font-bold text-zinc-100 mb-2 leading-snug">
        {title}
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── FAQ content ────────────────────────────────────────────────────────

const FAQ_ITEMS = [
  {
    q: 'How fast is it?',
    a: "Under a minute. We run all 81 queries in parallel against Google's local-pack feed. After you complete checkout, you'll enter your business details, and you'll get an email with your map and fix list as soon as the scan completes — usually 30-60 seconds later.",
  },
  {
    q: 'What keyword should I pick?',
    a: 'The keyword your highest-value customers actually search. For an HVAC operator: "ac repair [city]" or "furnace repair [city]" beats "hvac contractor." If you\'re not sure, our intake form helps you pick.',
  },
  {
    q: 'Is this US/Canada only?',
    a: 'Currently US and Canada. International support is on the roadmap.',
  },
  {
    q: "What if I don't appear in any cells?",
    a: "That happens — and it's actually one of the most useful diagnostic outcomes. It usually means Google doesn't recognize your business as competitive in your service area. The fix list addresses that directly.",
  },
  {
    q: 'How is this different from other rank-tracking tools?',
    a: 'Most rank trackers tell you one number from one search point. TurfMap runs 81 searches across your actual service area and shows you cell-by-cell visibility. Different data, different decisions.',
  },
  {
    q: 'What happens after I get my scan?',
    a: 'You get an email with your branded PDF report and access to your scan dashboard. From there, you can implement the fix list yourself, share it with your team or freelancer, or book a strategist walkthrough if you want help interpreting the results.',
  },
  {
    q: "What's the MAPCHECK50 code? Will it expire?",
    a: 'MAPCHECK50 is a $50 discount off the $99 TurfScan list price. It expires 24 hours from your first visit to this page. After that, the price returns to $99.',
  },
  {
    q: "Who's behind TurfMap?",
    a: 'Proprietary technology of Fourdots Digital, a Toronto agency. We built TurfMap because the rank-tracking tools we used on client work weren\'t telling us enough. We use it on every engagement.',
  },
];

// Silence unused-import warnings for icons used only in this file's JSX
// helpers (DeliverableCard takes a generic Icon prop). ChevronDown +
// Zap kept for future reuse.
void Zap;
void ChevronDown;
