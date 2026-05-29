'use client';

import { useState, type ReactNode } from 'react';
import { Check, Gift, Loader2 } from 'lucide-react';

/**
 * Three-tier pricing surface.
 *
 * Visual hierarchy is intentional, not symmetric: the middle tier is
 * the conversion target so it sits ~8px elevated above the outer two,
 * carries a "Most popular" badge, has a slightly brighter border + a
 * lime-tinted card surface, and is the only card whose CTA uses the
 * primary lime fill. The outer two CTAs are secondary outlines so the
 * eye lands on $499 first.
 *
 * All three tiers are intake-first now: clicking the CTA navigates
 * to /intake?tier=<id>&from=home where the buyer fills business
 * details, then hits Stripe Checkout, then auto-lands on
 * /order/success (no second form). Mirrors the same flow used by
 * /scan, /fourdots, /yourmap, /freescan landers.
 *
 *   TurfScan ($99)   → /intake?tier=scan&from=home   (1 keyword)
 *   Audit ($499)     → /intake?tier=audit&from=home  (1 keyword)
 *   Strategy ($1.5k) → /intake?tier=strategy&from=home (3 keywords)
 *
 * The legacy POST /api/checkout/<tier> path is still wired for
 * non-homepage entry points (subscription tiers, dev / fixture
 * flows) but no PricingCards button uses it anymore.
 */

type Tier = 'scan' | 'audit' | 'strategy';

type TierSpec = {
  id: Tier;
  name: string;
  price: string;
  priceCadence: string;
  /** Tagline + features accept ReactNode so we can use <strong> for
   *  disciplined emphasis on value phrases (e.g. "**90-day Roadmap**"
   *  in the Visibility Audit tagline). Render-site uses index-based
   *  keys for the features list since ReactNode isn't a stable key. */
  tagline: ReactNode;
  features: ReactNode[];
  /** Bonus row rendered with a Gift icon + lime-tinted text below the
   *  feature list. Mirrors the attach-banner offer ("Buy any audit,
   *  get 30 days of Pulse free") inside each card so the bonus is
   *  legible at a glance without the buyer having to scroll back to
   *  the section banner. */
  bonus?: string;
  cta: string;
  popular?: boolean;
};

const TIERS: TierSpec[] = [
  {
    id: 'scan',
    name: 'TurfScan',
    price: '$99',
    priceCadence: 'one-time',
    tagline: 'Find out what your map actually looks like.',
    features: [
      '81-point geo-grid scan, one keyword',
      'TurfReach + TurfRank + TurfScore',
      'Citation check across the directories that matter for your trade',
      'AI Coach: top 3 strategic recommendations, grounded in your real audit data',
      'Branded PDF report you can keep or share',
      'Delivered in under a minute',
    ],
    bonus: '30 days of TurfMap Pulse, free',
    cta: 'Order TurfScan',
  },
  {
    id: 'audit',
    name: 'Visibility Audit',
    price: '$499',
    priceCadence: 'one-time',
    tagline: (
      <>
        Scan + <strong className="font-semibold text-zinc-200">90-day Roadmap</strong> built around your map.
      </>
    ),
    features: [
      'Everything in TurfScan',
      <>
        30-minute{' '}
        <strong className="font-semibold text-zinc-100">
          strategist diagnostic call
        </strong>{' '}
        — live competitor teardown + score interpretation
      </>,
      'Per-vertical NAP audit — every directory specific to your trade',
      'Competitor analysis with heatmap overlay (your nearest 3 competitors)',
      <>
        <strong className="font-semibold text-zinc-100">
          90-Day Visibility Roadmap (PDF)
        </strong>{' '}
        — week-by-week action plan with projected TurfScore lift per action
      </>,
      '30-day automated re-scan to measure progress',
      '60-day strategist check-in call',
      <>
        <strong className="font-semibold text-zinc-100">
          TurfScore Lift Promise
        </strong>
        : minimum 10-point lift, or we redo the analysis free
      </>,
    ],
    bonus: '30 days of TurfMap Pulse, free',
    cta: 'Order Visibility Audit',
    popular: true,
  },
  {
    id: 'strategy',
    name: 'Strategy Session',
    price: '$1,497',
    priceCadence: 'one-time',
    tagline: 'The full picture — for operators ready to invest.',
    features: [
      'Everything in Visibility Audit',
      'Three TurfMap scans across different keywords or service variations',
      'Three competitor deep-dives — full GBP teardowns with annotated screenshots',
      '90-minute strategy session with a TurfMap strategist',
      'Strategist read on where to focus your investment',
      'Branded comparative report covering all three keyword angles',
    ],
    bonus: '30 days of TurfMap Pulse, free',
    cta: 'Book Strategy Session',
  },
];

export function PricingCards() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch pt-6">
      {TIERS.map((tier) => (
        <PricingCard key={tier.id} tier={tier} />
      ))}
    </div>
  );
}

function PricingCard({ tier }: { tier: TierSpec }) {
  const [busy, setBusy] = useState(false);

  const onCheckout = () => {
    // All three tiers route through the tier-aware /intake page.
    // The form collects business details (1 keyword for scan/audit,
    // 3 keywords for strategy), inits Stripe Checkout, then auto-
    // fulfills on /order/success. No POST here, no fetch error
    // surface needed — plain page navigation.
    //
    // from=home pins the /intake back link to / so cancel/back
    // returns the buyer to the homepage instead of the /scan lander.
    setBusy(true);
    window.location.href = `/intake?tier=${tier.id}&from=home`;
  };

  const popular = tier.popular === true;

  return (
    <div
      className="relative rounded-xl border p-7 flex flex-col transition-transform"
      style={{
        background: popular
          ? 'linear-gradient(180deg, var(--color-card-glow) 0%, var(--color-card) 100%)'
          : 'var(--color-card)',
        borderColor: popular
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
        boxShadow: popular
          ? '0 12px 48px #c5ff3a18, 0 0 0 1px #c5ff3a22'
          : 'none',
        transform: popular ? 'translateY(-8px)' : 'none',
      }}
    >
      {popular && (
        <div
          className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.18em] font-mono font-bold"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
            boxShadow: '0 4px 16px #c5ff3a40',
          }}
        >
          Most popular
        </div>
      )}

      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
        {tier.name}
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span
          className="font-display text-5xl font-bold"
          style={{ color: popular ? 'var(--color-lime)' : 'white' }}
        >
          {tier.price}
        </span>
        <span className="text-xs text-zinc-500 font-mono">
          {tier.priceCadence}
        </span>
      </div>
      <p className="text-sm text-zinc-400 leading-snug mb-6">{tier.tagline}</p>

      <ul className="space-y-2.5 mb-5 flex-1">
        {tier.features.map((f, i) => (
          // Index-based key: features can be ReactNode (we use <strong>
          // inline for value-phrase emphasis), so the prior key={f}
          // pattern won't compile. The list is static + doesn't reorder,
          // so index is stable.
          <li key={i} className="flex items-start gap-2.5 text-sm text-zinc-300">
            <Check
              size={14}
              strokeWidth={2.75}
              className="flex-shrink-0 mt-0.5"
              style={{ color: 'var(--color-lime)' }}
            />
            <span className="leading-snug">{f}</span>
          </li>
        ))}
      </ul>

      {tier.bonus && (
        // Bonus row — visually separated from the feature list with a
        // top divider + lime tint so the attach-trial offer reads as a
        // "this is on top" beat rather than a 7th bullet. Same Gift
        // icon used in the section attach banner so the buyer pattern-
        // matches the two surfaces as the same offer.
        <div
          className="mb-7 pt-3 border-t flex items-start gap-2.5 text-sm leading-snug"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-lime)',
          }}
        >
          <Gift
            size={14}
            strokeWidth={2.5}
            className="flex-shrink-0 mt-0.5"
          />
          <span>
            <span className="font-semibold">+ {tier.bonus}</span>
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={onCheckout}
        disabled={busy}
        className="w-full rounded-md font-bold text-sm py-3 px-4 flex items-center justify-center gap-2 transition-all whitespace-nowrap hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        style={
          popular
            ? {
                background: 'var(--color-lime)',
                color: 'black',
                boxShadow: '0 6px 20px #c5ff3a40',
              }
            : {
                background: 'transparent',
                color: '#e4e4e7',
                border: '1px solid var(--color-border)',
              }
        }
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? 'Redirecting…' : tier.cta}
      </button>
    </div>
  );
}
