'use client';

import { useState } from 'react';
import { Check, Clock, Loader2 } from 'lucide-react';

/**
 * Continuous-monitoring tier cards (Pulse / Pulse+).
 *
 * Sibling component to PricingCards (which renders the one-time-audit
 * tiers). Pulled into its own component because the data shape is
 * meaningfully different — these tiers are recurring (monthly +
 * annual price displayed on each card), and Pulse+ uses grouped
 * feature lists.
 *
 * Pulse+ repositioning (2026-05-04): the tier moved from "more
 * monitoring" to TurfMap's first ACTION tier — citation building
 * and ongoing maintenance are now bundled into the subscription.
 *
 *   - Tagline: "Pulse tells you what's broken. Pulse+ fixes it for you."
 *   - Pricing: $99/mo with a 3-month minimum subscription, OR
 *     $79/mo billed annually ($950/year, save $238 / 20%).
 *   - Feature list restructured into two groups:
 *       MORE MONITORING (the rank-tracking + integrations bits)
 *       CITATIONS + MAINTENANCE (the new action layer)
 *   - Propagation timeline honesty rail rendered on the card —
 *     non-optional, mandatory visible context. Without it, buyers
 *     churn at week 2-3 expecting instant results that physically
 *     can't land before week 4-6.
 *   - "Weekly automated scans" and "White-label PDF reports" bullets
 *     are removed. Pulse now has weekly scans (parity with
 *     BrightLocal Track at $39); white-label PDF was deprecated.
 *
 * Pulse (light update in the same change): 3 keywords (was 1) and
 * weekly scans (was monthly) so it stays competitive against
 * BrightLocal Track at the same price point.
 *
 * Visual hierarchy: Pulse+ is still the conversion target so it
 * keeps the +8px elevation, lime price color, "Most popular" badge,
 * and primary CTA.
 *
 * Stripe wiring: each CTA POSTs to /api/checkout/<pulse|pulse_plus>.
 * The Pulse+ monthly Price will be wrapped by a Subscription Schedule
 * (3-month committed phase, then month-to-month) at the API layer
 * once the Stripe products exist; this card just initiates checkout.
 */

type MonitoringTier = 'pulse' | 'pulse_plus';
type Cadence = 'monthly' | 'annual';

type FeatureGroup = {
  /** Optional sub-heading. Pulse uses a single ungrouped list; Pulse+
   *  uses grouped lists with sub-headings. */
  group?: string;
  items: string[];
};

type HonestyRail = {
  /** Short heading rendered with the icon. */
  title: string;
  /** Body copy beneath the heading. */
  body: string;
};

type MonitoringSpec = {
  id: MonitoringTier;
  name: string;
  monthlyPrice: string;
  /** Headline price when the buyer toggles to annual billing — same
   *  visual treatment as monthlyPrice when the toggle is on
   *  'annual'. Pulse: "$31"; Pulse+: "$79". */
  annualPriceMonthlyEquivalent: string;
  /** Total annual figure for the small line beneath the price. */
  annualTotal: string;
  /** Total annual savings expressed in dollars. */
  annualSavingsDollars: string;
  /** Optional sub-line directly under the price block — used for
   *  Pulse+ to surface the 3-month minimum at the same glance as the
   *  price. NOT a footnote; visible inline by design.
   *  Hidden when the buyer toggles to annual (the annual price
   *  doesn't have the minimum-commitment surface). */
  monthlySubNote?: string;
  tagline: string;
  /** "Everything in Pulse, plus:" line for the upgrade tier */
  inheritsFrom?: string;
  features: FeatureGroup[];
  /** Optional honesty-rail callout rendered between the bullet list
   *  and the CTA. Pulse+ uses this for the citation propagation
   *  timeline. */
  honestyRail?: HonestyRail;
  cta: string;
  popular?: boolean;
};

const TIERS: MonitoringSpec[] = [
  {
    id: 'pulse',
    name: 'TurfMap Pulse',
    monthlyPrice: '$39',
    annualPriceMonthlyEquivalent: '$31',
    annualTotal: '$372',
    annualSavingsDollars: '$96',
    tagline: 'Continuous monitoring of your local SEO territory.',
    features: [
      {
        items: [
          'Weekly automated TurfMap scan',
          'Up to 3 keywords, 1 location',
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
    monthlyPrice: '$99',
    annualPriceMonthlyEquivalent: '$79',
    annualTotal: '$950',
    annualSavingsDollars: '$238',
    monthlySubNote: '3-month minimum subscription',
    tagline: "Pulse tells you what's broken. Pulse+ fixes it for you.",
    inheritsFrom: 'Everything in Pulse, plus:',
    features: [
      {
        group: 'More monitoring',
        items: [
          'Up to 10 keywords',
          '12-month historical trend view',
          'Slack integration — alerts and weekly summaries to your channel',
          'Looker Studio + Google Sheets data export',
          'CSV raw data export',
          'Manual competitor tracking — pick up to 5 competitors',
          'Granular alerts — competitor entries, score drops, cell-level changes, Momentum reversals',
          'On-demand AI Coach refresh',
        ],
      },
      {
        group: 'Citations + maintenance',
        items: [
          'Initial citation building across ~25 industry directories',
          'Active maintenance and sync on 12 directories',
          'Per-directory live status in your dashboard',
          'Aggregator push (Data Axle, Foursquare, Localeze) for downstream propagation',
        ],
      },
    ],
    honestyRail: {
      title: 'How citations propagate',
      body: 'First wave of citations goes live within 2 weeks. Full propagation across all directories takes 6–8 weeks. Score lift typically visible in scans starting week 4 onward.',
    },
    cta: 'Start Pulse+',
    popular: true,
  },
];

export function MonitoringCards() {
  // Cadence toggle is hoisted to the parent so both Pulse and Pulse+
  // cards share state — flipping the toggle once switches both
  // headline prices simultaneously, which matches the buyer's mental
  // model ("show me both tiers in annual pricing").
  const [cadence, setCadence] = useState<Cadence>('monthly');

  return (
    <div className="pt-6">
      <CadenceToggle cadence={cadence} onChange={setCadence} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {TIERS.map((tier) => (
          <Card key={tier.id} tier={tier} cadence={cadence} />
        ))}
      </div>
    </div>
  );
}

/**
 * Monthly / annual cadence toggle. Lime accent on the active side,
 * subtle "save 20%" hint on the annual side so the buyer sees the
 * incentive without having to flip the toggle to find out. Pill-style
 * to read as a binary choice rather than a tab nav.
 */
function CadenceToggle({
  cadence,
  onChange,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
}) {
  return (
    <div className="flex items-center justify-center mb-6">
      <div
        role="radiogroup"
        aria-label="Billing cadence"
        className="inline-flex items-center gap-1 p-1 rounded-full border"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <CadenceButton
          active={cadence === 'monthly'}
          onClick={() => onChange('monthly')}
          label="Monthly"
        />
        <CadenceButton
          active={cadence === 'annual'}
          onClick={() => onChange('annual')}
          label="Annual"
          accent="save 20%"
        />
      </div>
    </div>
  );
}

function CadenceButton({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className="px-4 py-1.5 rounded-full text-xs font-mono font-semibold uppercase tracking-[0.18em] transition-all flex items-center gap-2"
      style={
        active
          ? {
              background: 'var(--color-lime)',
              color: 'black',
              boxShadow: '0 4px 14px #c5ff3a30',
            }
          : {
              background: 'transparent',
              color: '#a1a1aa',
            }
      }
    >
      {label}
      {accent && (
        <span
          className="text-[9px] tracking-wider px-1.5 py-0.5 rounded"
          style={{
            background: active
              ? 'rgba(0,0,0,0.15)'
              : 'rgba(197, 255, 58, 0.12)',
            color: active ? 'black' : 'var(--color-lime)',
          }}
        >
          {accent}
        </span>
      )}
    </button>
  );
}

function Card({
  tier,
  cadence,
}: {
  tier: MonitoringSpec;
  cadence: Cadence;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCheckout = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/checkout/${tier.id}?cadence=${cadence}`,
        { method: 'POST' }
      );
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
  const isAnnual = cadence === 'annual';
  const headlinePrice = isAnnual
    ? tier.annualPriceMonthlyEquivalent
    : tier.monthlyPrice;

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
          {headlinePrice}
        </span>
        <span className="text-xs text-zinc-500 font-mono">/month</span>
      </div>
      {/* 3-month-minimum sub-line — visible at same glance as the
          price. ONLY shown on the monthly cadence — annual already
          implicitly commits the buyer for 12 months. */}
      {tier.monthlySubNote && !isAnnual && (
        <div
          className="text-[11px] font-mono mb-1"
          style={{ color: '#c89545' }}
        >
          {tier.monthlySubNote}
        </div>
      )}
      <div className="text-[11px] text-zinc-600 font-mono mb-1">
        {isAnnual
          ? `${tier.annualTotal}/year billed today · save ${tier.annualSavingsDollars}`
          : `or ${tier.annualPriceMonthlyEquivalent}/mo billed annually (${tier.annualTotal}/year — save ${tier.annualSavingsDollars} / 20%)`}
      </div>
      <p className="text-sm text-zinc-400 leading-snug mt-3 mb-5">
        {tier.tagline}
      </p>

      {tier.inheritsFrom && (
        <p className="text-xs text-zinc-500 font-mono uppercase tracking-wider mb-3">
          {tier.inheritsFrom}
        </p>
      )}

      <div className="space-y-4 mb-5 flex-1">
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

      {tier.honestyRail && (
        // Required propagation-timeline callout. Same visual treatment
        // as the "Grounded in real data" rail in §03 — small icon,
        // lime-tinted card-glow background, smaller typography than the
        // bullets above. Sits between the feature list and the CTA so
        // the buyer reads it BEFORE clicking.
        <div
          className="rounded-md border px-3 py-2.5 mb-6 flex items-start gap-2.5"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'var(--color-border-bright)',
          }}
        >
          <Clock
            size={13}
            className="flex-shrink-0 mt-0.5"
            style={{ color: 'var(--color-lime)' }}
          />
          <div>
            <div className="text-xs font-semibold text-zinc-200 mb-1 leading-snug">
              {tier.honestyRail.title}
            </div>
            <div className="text-[11px] text-zinc-400 leading-snug">
              {tier.honestyRail.body}
            </div>
          </div>
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
        {busy
          ? 'Redirecting…'
          : `${tier.cta} — ${headlinePrice}/mo${isAnnual ? ' (billed yearly)' : ''}`}
      </button>

      {error && (
        <div className="text-[11px] text-red-400 font-mono mt-3 text-center leading-snug">
          {error}
        </div>
      )}
    </div>
  );
}
