import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Check,
  Clock,
  Crosshair,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { ScanCheckoutButton } from '@/components/marketing/ScanCheckoutButton';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
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
  // No marketing-page indexing — this is a paid-traffic LP, not a
  // canonical entry point. We don't want it competing with / for
  // brand keywords or bleeding into organic results.
  robots: { index: false, follow: false },
};

/**
 * Single-purpose landing page for paid + warm traffic — most often
 * an exit-intent popup on the parent fourdots.io site offering $50
 * off TurfScan via code FOURDOTS50.
 *
 * Why a dedicated page (not a deep link into / + scroll-to-pricing):
 * paid-traffic conversion lift on dedicated LPs is typically 2-5x
 * vs. the marketing homepage. The full marketing page is built to
 * teach + sell *cold* traffic — this audience is already half-sold
 * and shouldn't have to navigate through Sections 02/03/05/06 to
 * reach a buy button. Every word between "interested" and "Stripe
 * checkout open" is a bounce risk.
 *
 * Stripped vs. /:
 *   - No <MarketingNav>: the popup sent them here for one thing,
 *     don't let them wander into /login or /clients.
 *   - No Section 02 (problem statement) or Section 03 (score
 *     anatomy): they already accepted the premise by clicking the
 *     popup.
 *   - No Section 04 (pricing comparison): only one SKU is on offer
 *     here; comparison is friction.
 *   - Minimal footer: legal links only (Privacy / Terms).
 *
 * URL contract — all params are optional:
 *   ?tier=scan         — currently the only supported tier; future
 *                        landers may use /scan/audit etc.
 *   ?coupon=FOURDOTS50 — looked up against lib/coupons/knownCoupons
 *                        for client-side price math; the raw string
 *                        is forwarded to Stripe at checkout time and
 *                        validated there too.
 *   ?utm_source / utm_medium / utm_campaign — forwarded to Stripe
 *                        metadata + GA4 begin_checkout event.
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

  return (
    <div className="min-h-screen w-full text-white">
      {/* Minimal nav — wordmark only, no menu. Links back to /
          for the rare case someone wants to compare tiers or read
          more before buying; otherwise keep eyes forward. */}
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

      {/* Hero + offer panel — single block. The buy button lives
          inside the offer panel so the buyer never has to scroll
          past the price math to find a CTA. */}
      <section className="px-6 md:px-10 pt-10 md:pt-14 pb-10 max-w-3xl mx-auto">
        <OfferEyebrow showDiscount={showDiscount} couponLabel={coupon?.label} />

        <h1 className="font-display text-4xl md:text-5xl font-bold leading-[1.05] tracking-tight mb-4">
          See exactly where you <em>win</em> — and where you{' '}
          <em>don&rsquo;t.</em>
        </h1>

        <p className="text-zinc-300 text-base md:text-lg leading-relaxed mb-8 max-w-2xl">
          TurfMap runs an 81-point geo-grid scan across your service
          area and shows you, cell by cell, where you appear in
          Google&rsquo;s local 3-pack.{' '}
          <strong className="font-semibold text-zinc-100">
            Most local businesses are invisible to two-thirds of the
            people searching for them.
          </strong>{' '}
          TurfScan is the diagnostic that tells you which cells, and
          what to fix first.
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
      </section>

      {/* What's included — 6 bullets matching PricingCards' TurfScan
          tier. Bullets are crisp; this page should not re-pitch the
          product to the level of detail Section 02 + 03 do. */}
      <section className="px-6 md:px-10 pb-12 max-w-3xl mx-auto">
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
      </section>

      {/* Trust strip — three small reassurances. Mirrors the closing
          CTA on / but compressed since this page is shorter. */}
      <section
        className="px-6 md:px-10 py-6 border-y"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-8">
          <TrustItem icon={ShieldCheck} label="Refund window">
            Full refund within 24h if your scan hasn&rsquo;t been
            delivered.
          </TrustItem>
          <TrustItem icon={Clock} label="Delivery">
            Scan completes in &lt; 1 min. AI Coach fix list emailed
            with your map.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by operators">
            Fourdots Digital uses TurfMap on its own clients every
            day.
          </TrustItem>
        </div>
      </section>

      {/* FAQ — 4 risk reversers chosen to address the specific
          objections an exit-intent buyer is likely to have:
          relevance, time, language, and refund. */}
      <section className="px-6 md:px-10 py-12 max-w-3xl mx-auto">
        <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-4">
          <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
          Common questions
        </div>
        <FAQAccordion
          items={[
            {
              q: 'How is this different from just Googling myself?',
              a: (
                <>
                  Google personalizes local results by your physical
                  location. From your office, you&rsquo;ll always see
                  yourself near the top — that&rsquo;s not proof you
                  rank well, it&rsquo;s proof Google knows where you
                  are. TurfScan checks 81 different points across
                  your service area to show you what customers across
                  town actually see.
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
                  details on the order form, you&rsquo;ll get an
                  email with a link to your map and your AI Coach
                  fix list.
                </>
              ),
            },
            {
              q: 'What keyword should I pick?',
              a: (
                <>
                  Pick the most-searched term someone in your service
                  area would type to find a business like yours. For
                  a plumber, that&rsquo;s usually <code>plumber [city]</code>{' '}
                  — not your business name, not a niche service.
                  Unsure? Pick what you&rsquo;d type if you needed
                  your own service in a city you don&rsquo;t live in.
                </>
              ),
            },
            {
              q: 'What if I find out my visibility is bad?',
              a: (
                <>
                  Then the $49 TurfScan just paid for itself. The AI
                  Coach fix list spells out the top 3 highest-leverage
                  actions specific to your business and category — you,
                  your team, or your existing freelancer can act on
                  them. If you want done-for-you fixes, we&rsquo;ll
                  point you at the right Fourdots Digital service on
                  the way out.
                </>
              ),
            },
          ]}
        />
      </section>

      {/* Closing CTA — second buy button so buyers who scrolled to
          read the FAQ don't have to scroll all the way back up. */}
      <section className="px-6 md:px-10 pb-16 max-w-3xl mx-auto">
        <div
          className="rounded-lg p-6 md:p-8 border text-center"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'var(--color-border-bright)',
          }}
        >
          <div className="font-display text-xl md:text-2xl font-bold mb-2">
            Ready to see your map?
          </div>
          <p className="text-sm text-zinc-400 mb-5">
            {showDiscount
              ? `${formatUsd(finalCents)} TurfScan with `
              : `${formatUsd(finalCents)} TurfScan — `}
            {showDiscount && coupon ? (
              <span className="font-mono text-zinc-200">
                {coupon.code}
              </span>
            ) : (
              'one-time, no subscription.'
            )}
            {showDiscount ? ' applied at checkout.' : ''}
          </p>
          <ScanCheckoutButton
            coupon={couponCode}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
            label={`Get my ${formatUsd(finalCents)} TurfScan`}
          />
        </div>
      </section>

      {/* Minimal footer — legal links only, no nav. */}
      <footer
        className="border-t px-6 md:px-10 py-6 text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-3">
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
 * Lime-on-dark eyebrow that sits above the hero. When a discount is
 * active, surfaces "EXIT-INTENT OFFER · $50 OFF" to anchor the
 * promotional context; without a coupon it reads as a generic
 * audit-tier eyebrow.
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
          <span style={{ color: 'var(--color-lime)' }}>
            Exit-intent offer
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">{couponLabel}</span>
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
 * Price + CTA panel. Strikethrough list price + lime final price
 * when a discount is active; single price + clean CTA otherwise.
 * Sits as the primary above-the-fold conversion element.
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
      className="rounded-lg p-6 md:p-7 border"
      style={{
        background: showDiscount
          ? 'var(--color-card-glow)'
          : 'var(--color-card)',
        borderColor: showDiscount
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
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
