import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Check,
  Clock,
  Compass,
  Crosshair,
  Crown,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { ScanCheckoutButton } from '@/components/marketing/ScanCheckoutButton';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { buildHeroCells, HERO_METRICS } from '@/components/marketing/heroSeed';
import {
  finalPriceCents,
  formatUsd,
  lookupCoupon,
  type CouponDescriptor,
} from '@/lib/coupons/knownCoupons';

export const metadata: Metadata = {
  title: 'Get your $49 TurfScan — TurfMap',
  description:
    'See exactly where you rank across your service area. 81-point geo-grid scan + AI Coach fix list, delivered in under a minute. $50 off with code FOURDOTS50.',
  // Paid-traffic LP — not a canonical entry point. Don't compete
  // with / for brand keywords or bleed into organic results.
  robots: { index: false, follow: false },
};

/**
 * Single-purpose landing page for paid + warm traffic — most often
 * the exit-intent popup on the parent fourdots.io site offering $50
 * off TurfScan via FOURDOTS50.
 *
 * Why a dedicated page (not /#section-04 deep link): paid-traffic
 * conversion lift on dedicated LPs is typically 2-5x vs. the
 * marketing homepage. The full marketing page is built to teach +
 * sell *cold* traffic; this audience is already half-sold and
 * shouldn't have to navigate Sections 02/03/05/06 to reach a buy
 * button.
 *
 * Stripped vs. /:
 *   - No <MarketingNav>: don't let them wander into /login or /clients.
 *   - No comparison-pricing block: only one SKU is on offer here.
 *   - Compressed problem framing inline in the hero copy instead
 *     of a separate Section 02.
 *   - Lighter score-anatomy and Fix-List preview blocks vs. the
 *     full Section 03.
 *
 * KEPT (vs. earlier bare-bones revision):
 *   - Animated heatmap in the hero (the most powerful visual proof
 *     element on the entire site — paid traffic deserves to see
 *     what they're paying for).
 *   - Score-card preview row (Reach/Rank/Score with example values
 *     and band labels).
 *   - AI Coach Fix-List preview (three example actions in the
 *     dark-green panel) — this is the deliverable, not just the
 *     metrics.
 *   - "Grounded in real data" callout on the Fix List.
 *   - Trust strip + FAQ + closing CTA.
 *
 * URL contract — all params optional:
 *   ?coupon=FOURDOTS50 — looked up against lib/coupons/knownCoupons
 *                        for client-side price math; the raw string
 *                        is forwarded to Stripe at checkout time.
 *   ?utm_*             — forwarded to Stripe metadata + GA4
 *                        begin_checkout event.
 *   ?gclid             — Google Ads click id, same forwarding path.
 *
 * If the coupon is unknown or doesn't match the tier, the lander
 * gracefully falls back to full-price rendering. Checkout still
 * works (Stripe's promo-code field stays open as a safety net).
 */
export default async function ScanLandingPage({
  searchParams,
}: {
  // Next.js 15+ types searchParams as a Promise.
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const couponCode = pickFirst(params.coupon);
  const utmSource = pickFirst(params.utm_source);
  const utmMedium = pickFirst(params.utm_medium);
  const utmCampaign = pickFirst(params.utm_campaign);
  const gclid = pickFirst(params.gclid);

  const coupon = lookupCoupon(couponCode, 'scan');
  const listCents = 9900; // TurfScan list price; mirrors Stripe Price.
  const showDiscount = coupon !== null;
  const finalCents = coupon ? finalPriceCents(coupon) : listCents;

  // Hero heatmap + metrics — same source data as the homepage hero
  // so the lander reads as a focused excerpt of /, not a different
  // product.
  const cells = buildHeroCells();
  const { reach, rank, score, band } = HERO_METRICS;

  return (
    <div className="min-h-screen w-full text-white">
      {/* Minimal nav — wordmark only, no menu. Returning visitors get
          /login as the secondary affordance; everyone else stays
          eyes-forward toward the offer. */}
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
        <Link
          href="/login"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Existing customer?
        </Link>
      </header>

      {/* HERO — two-column on desktop, stacks on mobile.
       *  Left: eyebrow + H1 + problem framing + offer panel (price
       *  + CTA). The buy button sits inside the offer panel so the
       *  buyer hits CTA without scrolling past anything.
       *  Right: animated heatmap + ScoreReadout row — the strongest
       *  visual proof element on the site. */}
      <section className="relative px-6 md:px-10 pt-12 md:pt-16 pb-12 overflow-hidden">
        {/* Subtle radial lime glow behind the heatmap — same
         *  treatment as the homepage hero so the page reads as a
         *  focused variant of /, not a different brand surface. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 75% 40%, #c5ff3a14 0%, transparent 60%)',
          }}
        />

        <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          {/* Left: copy + offer panel */}
          <div className="lg:col-span-7">
            <OfferEyebrow showDiscount={showDiscount} couponLabel={coupon?.label} />

            <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.04] tracking-tight mb-4">
              See exactly where you <em>win</em> — and where you{' '}
              <em>don&rsquo;t.</em>
            </h1>

            <p className="font-display text-lg md:text-xl text-zinc-300 italic leading-snug mb-5 max-w-xl">
              The Google Maps audit you should run before spending another
              dollar on local SEO.
            </p>

            <p className="text-zinc-300 text-base md:text-lg leading-relaxed max-w-xl mb-7">
              TurfMap runs an 81-point geo-grid scan across your service
              area and shows you, cell by cell, where you appear in
              Google&rsquo;s local 3-pack.{' '}
              <strong className="font-semibold text-zinc-100">
                Most local businesses are invisible to two-thirds of
                the people searching for them.
              </strong>
            </p>

            <PricePanel
              listCents={listCents}
              finalCents={finalCents}
              coupon={coupon}
              couponCode={couponCode}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
            />

            {/* Mini trust line under the price panel — three quick
             *  reassurances in mono, lime-bullet style matching the
             *  homepage hero. */}
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-500 font-mono">
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                Delivered in under a minute
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                24-hour refund window
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                81 real searches
              </span>
            </div>
          </div>

          {/* Right: animated heatmap + inline score readout */}
          <div className="lg:col-span-5">
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
                  Sample · Plumber, midtown
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
              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
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
            <p className="text-[11px] text-zinc-600 font-mono mt-2 text-center">
              Anonymized — your map will look different.
            </p>
          </div>
        </div>
      </section>

      {/* WHAT YOU'LL GET — Fix List preview. The AI Coach output is
       *  the deliverable buyers walk away with; showing the example
       *  cards converts harder than describing them. Mirrors the
       *  homepage Section 03 treatment but dropped of the score-card
       *  primary block since we already showed scores in the hero. */}
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
            What you walk away with
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-3 max-w-3xl">
            A prioritized fix list. <em>In plain English.</em>
          </h2>
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
              {[
                {
                  priority: 'HIGH',
                  title:
                    'Verify your Apple Maps listing — currently unverified',
                  body: 'iPhone users searching from the northern half of your service area get directed to a verified competitor. Verifying the listing is a 5-minute fix that immediately reclaims those cells.',
                },
                {
                  priority: 'HIGH',
                  title: 'Claim 8 missing industry directories',
                  body: 'For this plumber: Angi, HomeAdvisor, Thumbtack, BBB, and 4 others — all absent. The exact list is industry-specific. Citation authority on the directories Google cross-references is the fastest TurfReach lever.',
                },
                {
                  priority: 'MEDIUM',
                  title: 'Normalize address format on Bing, Yelp, MapQuest',
                  body: 'Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals.',
                },
              ].map((a, i) => (
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

            {/* Grounding callout — articulates what makes the AI
             *  Coach different from generic SEO chatbots. Same
             *  pattern as homepage Section 03. */}
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
                business listing, and the moves that map to your
                industry. No generic SEO advice — real audit findings,
                prioritized.
              </div>
            </div>

            <p className="text-xs text-zinc-600 font-mono mt-3">
              Sample output. Your actions will be specific to your business,
              category, and what your map reveals.
            </p>
          </div>
        </div>
      </section>

      {/* SCORE ANATOMY — compressed three-card grid. Lighter than
       *  homepage Section 03 (no band tables, no detailed
       *  paragraphs); each card is a one-line definition + an
       *  example value. Buyers don't need the full methodology
       *  here — they need to know the three numbers exist and what
       *  they mean. */}
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

      {/* WHAT'S INCLUDED — bullet list. Crisp, mirrors PricingCards'
       *  TurfScan tier verbatim so the offer matches the homepage
       *  pricing card the buyer might have seen. */}
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

          {/* Pulse-trial pre-purchase teaser — sets the expectation
           *  before checkout that the buyer will be offered 30 free
           *  days of Pulse on the order-success page. Mirrors the
           *  Gift-icon treatment used on the homepage PricingCards
           *  bonus row so the visual rhythm carries across surfaces. */}
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
                {' '}— offered on your order-confirmation page. Cancel
                anytime before day 31 to pay nothing.
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* TRUST STRIP — three small reassurances. Tinted background
       *  to break the page rhythm + signal "the trust beat." */}
      <section
        className="px-6 md:px-10 py-8 border-y"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-8">
          <TrustItem icon={ShieldCheck} label="Refund window">
            Full refund within 24h if your scan hasn&rsquo;t been delivered.
          </TrustItem>
          <TrustItem icon={Clock} label="Delivery">
            Scan completes in &lt; 1 min. AI Coach fix list lands in your
            inbox alongside your map.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by operators">
            Fourdots Digital uses TurfMap on its own clients every day.
          </TrustItem>
        </div>
      </section>

      {/* FAQ — 4 risk reversers. Same accordion pattern as the
       *  homepage so returning visitors recognize the affordance. */}
      <section className="px-6 md:px-10 py-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            Common questions
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold leading-tight tracking-tight mb-6 max-w-xl">
            Things people ask before <em>they buy.</em>
          </h2>
          {/* "What if I find out my visibility is bad?" leads the FAQ
           *  and renders open by default — it's the highest-objection
           *  question on the page (the implicit "what if this just
           *  confirms I'm screwed?" worry). FAQAccordion auto-expands
           *  the first item, so the order here drives the
           *  default-open state. The other three start collapsed. */}
          <FAQAccordion
            items={[
              {
                q: 'What if I find out my visibility is bad?',
                a: (
                  <>
                    Visibility problems are fixable. Every TurfScan ends
                    with the AI Coach Fix List — the top three actions
                    to fix in priority order, specific to your business
                    and category. Most buyers walk away with a clear
                    plan they can act on in under an hour, or hand off
                    to a freelancer or team member.
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
                    Pick the most-searched term someone in your service
                    area would type to find a business like yours. For a
                    plumber, that&rsquo;s usually <code>plumber [city]</code>{' '}
                    — not your business name, not a niche service. Unsure?
                    Pick what you&rsquo;d type if you needed your own
                    service in a city you don&rsquo;t live in.
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* CLOSING CTA — second buy button so buyers who scrolled to
       *  read the FAQ don't have to scroll all the way back up.
       *  Larger, brighter, tinted — visually the page's loudest beat.
       *  The worst-case/best-case frame above the price reminder
       *  mirrors the closing language on the main marketing page —
       *  reframes the $49 as a low-risk diagnostic regardless of
       *  what the scan turns up. */}
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
              Ready to see your map?
            </div>
            <p className="text-sm md:text-base text-zinc-300 mb-1 max-w-md mx-auto leading-relaxed">
              <strong className="font-semibold text-zinc-100">
                Worst case:
              </strong>{' '}
              {formatUsd(finalCents)} confirms what you suspect.
            </p>
            <p className="text-sm md:text-base text-zinc-300 mb-3 max-w-md mx-auto leading-relaxed">
              <strong className="font-semibold text-zinc-100">
                Best case:
              </strong>{' '}
              one fix pays for the scan ten times over.
            </p>
            <p className="text-xs md:text-sm text-zinc-500 mb-6 max-w-md mx-auto leading-relaxed">
              {showDiscount && coupon ? (
                <>
                  {formatUsd(finalCents)} TurfScan with{' '}
                  <span className="font-mono text-zinc-300">
                    {coupon.code}
                  </span>{' '}
                  applied at checkout. One-time, no subscription.
                </>
              ) : (
                <>{formatUsd(finalCents)} TurfScan. One-time, no subscription.</>
              )}
            </p>
            <ScanCheckoutButton
              coupon={couponCode}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              label={`Get my ${formatUsd(finalCents)} TurfScan`}
              centered
            />
          </div>

          {/* Audit-ladder offramp — small, low-contrast, no accent
           *  color or button styling. Mirrors the "Looking for full-
           *  service local SEO instead..." footer line on the main
           *  pricing page. The buyer who's curious clicks; the
           *  buyer who's committed to $49 ignores it without
           *  feeling pulled. */}
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

      {/* Minimal footer — legal links only, no nav. */}
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

/**
 * Lime-on-dark eyebrow above the hero. Customer-facing language:
 * when a discount is active it surfaces the value of the offer
 * directly ($50 off · TurfScan), without leaking internal terms
 * like "exit-intent." Without a coupon it reads as a generic
 * audit-tier eyebrow consistent with the homepage hero.
 */
function OfferEyebrow({
  showDiscount,
  couponLabel,
}: {
  showDiscount: boolean;
  couponLabel?: string;
}) {
  return (
    <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-5 flex items-center gap-2 flex-wrap">
      <span style={{ color: 'var(--color-lime)' }}>●</span>
      {showDiscount ? (
        <>
          <span style={{ color: 'var(--color-lime)' }}>{couponLabel}</span>
          <span className="text-zinc-600">·</span>
          <span>TurfScan · One-time audit</span>
        </>
      ) : (
        <>
          <span style={{ color: 'var(--color-lime)' }}>TurfScan</span>
          <span className="text-zinc-600">·</span>
          <span>One-time audit · From $99</span>
        </>
      )}
    </div>
  );
}

/**
 * Price + CTA panel in the hero. Strikethrough list price + lime
 * final price when a discount is active; clean single price + CTA
 * otherwise. The CTA inherits the page's primary button styling
 * (lime bg, dark text) — visible from anywhere above-the-fold on
 * desktop.
 */
function PricePanel({
  listCents,
  finalCents,
  coupon,
  couponCode,
  utmSource,
  utmMedium,
  utmCampaign,
  gclid,
}: {
  listCents: number;
  finalCents: number;
  coupon: CouponDescriptor | null;
  couponCode: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  gclid: string | null;
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
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
            TurfScan
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            {showDiscount && (
              <span className="font-display text-2xl md:text-3xl text-zinc-600 line-through font-semibold">
                {formatUsd(listCents)}
              </span>
            )}
            <span
              className="font-display text-4xl md:text-5xl font-bold"
              style={{
                color: showDiscount ? 'var(--color-lime)' : '#ffffff',
              }}
            >
              {formatUsd(finalCents)}
            </span>
            <span className="text-xs text-zinc-500 font-mono">one-time</span>
          </div>
          {showDiscount && coupon && (
            <p className="text-xs text-zinc-400 mt-2">
              <span className="font-mono text-zinc-200">{coupon.code}</span>{' '}
              applied at checkout — no manual code needed.
            </p>
          )}
        </div>
        <ScanCheckoutButton
          coupon={couponCode}
          utmSource={utmSource}
          utmMedium={utmMedium}
          utmCampaign={utmCampaign}
          gclid={gclid}
          label={`Get my ${formatUsd(finalCents)} TurfScan`}
        />
      </div>
    </div>
  );
}

/**
 * Inline three-stat readout shown beneath the hero heatmap. Mirrors
 * the homepage hero's ScoreReadout exactly — same typography, same
 * highlight treatment for TurfScore. Duplicated rather than shared
 * because it's small and the marketing surfaces have diverged
 * before; keeping local copies avoids accidental cross-page
 * regressions when one is tweaked.
 */
function ScoreReadout({
  label,
  value,
  highlight = false,
  bandLabel,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  bandLabel?: string;
}) {
  return (
    <div
      className="rounded-md py-2.5"
      style={{
        background: highlight ? '#0d130a' : 'transparent',
        border: highlight ? '1px solid var(--color-border-bright)' : 'none',
      }}
    >
      <div className="text-[10px] tracking-[0.04em] text-zinc-500 font-mono font-semibold mb-1">
        {label}
      </div>
      <div
        className="font-display font-bold text-lg leading-none"
        style={{ color: highlight ? 'var(--color-lime)' : '#e4e4e7' }}
      >
        {value}
      </div>
      {bandLabel && (
        <div
          className="text-[9px] font-mono uppercase tracking-wider mt-1"
          style={{ color: 'var(--color-lime)', opacity: 0.85 }}
        >
          {bandLabel}
        </div>
      )}
    </div>
  );
}

/**
 * Compressed score-card for the lander's "How we measure" section.
 * Lighter than the homepage Section 03 ScoreCard (no band tables,
 * no full description paragraph) — just icon + name + tagline +
 * range + one-line example. Matches the homepage card's tinted
 * highlight treatment for TurfScore so the visual hierarchy
 * carries over.
 */
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

/**
 * One row in the trust strip. Icon + small mono label + body. Same
 * visual language as the closing CTA on the main marketing page so
 * returning visitors recognize the rhythm.
 */
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

/** Pick the first string from a Next.js searchParams value — collapses
 *  string | string[] | undefined into a clean string-or-null. */
function pickFirst(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
