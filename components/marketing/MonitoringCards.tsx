'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * Continuous-monitoring tier cards (Pulse / Pulse+).
 *
 * Sibling component to PricingCards (which renders the one-time-audit
 * tiers). Pulled into its own component because the data shape is
 * meaningfully different — these tiers are recurring (monthly +
 * annual price displayed on each card), and Pulse+ uses grouped
 * feature lists ("More data", "More integration", "More flexibility")
 * rather than the flat list the audit cards use.
 *
 * Visual hierarchy: Pulse+ is the conversion target so it gets the
 * +8px elevation, lime price color, "Most popular" badge, and primary
 * CTA — same pattern PricingCards uses for the $499 audit. Pulse is
 * the entry stake at $39/mo.
 *
 * Stripe wiring: each CTA POSTs to /api/checkout/<pulse|pulse_plus>.
 * Until those Stripe products + price IDs are created, the route
 * returns 503 with a human-readable message that the card surfaces
 * inline. Lets us ship the marketing surface immediately and wire
 * billing in a follow-up.
 *
 * Annual billing: shown as a secondary "save 20%" line on each card
 * but not yet wired to a separate Stripe price. The CTA always starts
 * the monthly subscription. Annual checkout flow is a follow-up —
 * needs a billing-cadence toggle + a second price ID per tier.
 */

type MonitoringTier = 'pulse' | 'pulse_plus';

type FeatureGroup = {
  /** Optional sub-heading. Pulse uses a single ungrouped list; Pulse+
   *  uses grouped lists with sub-headings. */
  group?: string;
  items: string[];
};

type MonitoringSpec = {
  id: MonitoringTier;
  name: string;
  monthlyPrice: string;
  annualPriceMonthly: string;
  annualSavings: string;
  tagline: string;
  /** "Everything in Pulse, plus:" line for the upgrade tier */
  inheritsFrom?: string;
  features: FeatureGroup[];
  cta: string;
  popular?: boolean;
};

const TIERS: MonitoringSpec[] = [
  {
    id: 'pulse',
    name: 'TurfMap Pulse',
    monthlyPrice: '$39',
    annualPriceMonthly: '$31',
    annualSavings: 'save 20%',
    tagline: 'Continuous monitoring of your local SEO territory.',
    features: [
      {
        items: [
          'Monthly automated TurfMap scan',
          '1 keyword, 1 location',
          '9×9 grid covering your service area',
          'Full dashboard — TurfScore, TurfReach, TurfRank, Momentum',
          'Weekly competitor movement summary',
          'Email alerts on TurfScore movement of 5+ points',
          'Monthly automated PDF report',
          'TurfMap AI Coach playbook refreshed each scan',
          'Cancel anytime',
        ],
      },
    ],
    cta: 'Start Pulse',
  },
  {
    id: 'pulse_plus',
    name: 'TurfMap Pulse+',
    monthlyPrice: '$89',
    annualPriceMonthly: '$71',
    annualSavings: 'save 20%',
    tagline: 'Professional-tier monitoring for serious operators.',
    inheritsFrom: 'Everything in Pulse, plus:',
    features: [
      {
        group: 'More data',
        items: [
          'Weekly automated scans',
          'Up to 3 keywords',
          '12-month historical trend view',
        ],
      },
      {
        group: 'More integration',
        items: [
          'Slack integration — alerts and weekly summaries to your channel',
          'Looker Studio + Google Sheets data export',
          'CSV raw data export',
          'White-label PDF reports',
        ],
      },
      {
        group: 'More flexibility',
        items: [
          'Manual competitor tracking — pick up to 5 competitors',
          'Granular alerts — competitor entries, score drops, cell-level changes, Momentum reversals',
          'On-demand AI Coach refresh — re-run anytime',
        ],
      },
    ],
    cta: 'Start Pulse+',
    popular: true,
  },
];

export function MonitoringCards() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch pt-6">
      {TIERS.map((tier) => (
        <Card key={tier.id} tier={tier} />
      ))}
    </div>
  );
}

function Card({ tier }: { tier: MonitoringSpec }) {
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
          ⭐ Most popular
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
          {tier.monthlyPrice}
        </span>
        <span className="text-xs text-zinc-500 font-mono">/month</span>
      </div>
      <div className="text-[11px] text-zinc-600 font-mono mb-1">
        or {tier.annualPriceMonthly}/mo billed annually&nbsp;·&nbsp;
        <span style={{ color: 'var(--color-lime)' }}>
          {tier.annualSavings}
        </span>
      </div>
      <p className="text-sm text-zinc-400 leading-snug mt-3 mb-5">
        {tier.tagline}
      </p>

      {tier.inheritsFrom && (
        <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider mb-3">
          {tier.inheritsFrom}
        </p>
      )}

      <div className="space-y-4 mb-7 flex-1">
        {tier.features.map((group, gi) => (
          <div key={gi}>
            {group.group && (
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
                {group.group}
              </div>
            )}
            <ul className="space-y-2">
              {group.items.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2.5 text-sm text-zinc-300"
                >
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
          </div>
        ))}
      </div>

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
        {busy ? 'Redirecting…' : `${tier.cta} — ${tier.monthlyPrice}/mo`}
      </button>

      {error && (
        <div className="text-[11px] text-red-400 font-mono mt-3 text-center leading-snug">
          {error}
        </div>
      )}
    </div>
  );
}
