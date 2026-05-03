'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

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
 * Each CTA POSTs to /api/checkout/<tier>, the server creates a Stripe
 * Checkout session, the response includes the redirect URL. Client
 * navigates there. Failure mode: the API responds 503 + an error
 * envelope when STRIPE_SECRET_KEY or the per-tier price-id env var
 * is unset (pre-Stripe-config). The button surfaces that copy inline
 * so the page doesn't silently fail during the period before the
 * Stripe products are created.
 */

type Tier = 'scan' | 'audit' | 'strategy';

type TierSpec = {
  id: Tier;
  name: string;
  price: string;
  priceCadence: string;
  tagline: string;
  features: string[];
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
      'AI Coach: top 3 strategic recommendations',
      'PDF report you can keep or share',
      'Delivered in under a minute',
    ],
    cta: 'Order TurfScan',
  },
  {
    id: 'audit',
    name: 'Visibility Audit',
    price: '$499',
    priceCadence: 'one-time',
    tagline: 'Scan + diagnosis on what to fix first.',
    features: [
      'Everything in TurfScan',
      'NAP audit — every directory checked',
      'GBP optimization checklist (specific to your category)',
      'Citation-gap analysis vs your nearest 3 competitors',
      'Written diagnostic from a real strategist (not just AI)',
      '30-day re-scan included to measure your fixes',
    ],
    cta: 'Order Visibility Audit',
    popular: true,
  },
  {
    id: 'strategy',
    name: 'Strategy Session',
    price: '$1,497',
    priceCadence: 'one-time',
    tagline: 'Audit + a 90-min call to build the playbook.',
    features: [
      'Everything in Visibility Audit',
      'Three keywords scanned (vs one)',
      '90-minute strategy call with our SEO lead',
      '12-week priority-stacked action plan',
      'Two re-scans (60 + 90 days) to verify lift',
      'Direct line to the strategist for follow-up Qs',
    ],
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
  const [error, setError] = useState<string | null>(null);

  const onCheckout = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/checkout/${tier.id}`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        setError(data.error ?? `checkout unavailable (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
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

      <ul className="space-y-2.5 mb-7 flex-1">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-zinc-300">
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

      {error && (
        <div className="text-[11px] text-red-400 font-mono mt-3 text-center leading-snug">
          {error}
        </div>
      )}
    </div>
  );
}
