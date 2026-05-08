'use client';

import { useState } from 'react';
import {
  ArrowRight,
  Bell,
  Check,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type PulseAttachPanelProps = {
  /** Existing client public_id from the just-completed fulfillment.
   *  Used by /api/checkout/pulse-attach to validate the (publicId,
   *  stripeCustomerId) pair against the clients table. */
  publicId: string;
  /** Stripe Customer id captured during the original one-time
   *  checkout. We pre-bind this on the new subscription session so
   *  the buyer doesn't have to re-enter their email — Stripe Checkout
   *  resolves them to the same customer. */
  stripeCustomerId: string;
  /** The cs_xxx id of the ORIGINAL one-time purchase. The Pulse-attach
   *  API uses this to craft a success_url that returns the buyer back
   *  to /order/success with their original session intact. */
  originalSessionId: string;
};

/**
 * Post-purchase Pulse attach offer — the "30-day free trial of
 * TurfMap Pulse" upsell on the order-success page.
 *
 * Renders only for one-time tiers (scan / audit / strategy) and only
 * when the buyer hasn't already opted in. The OrderSuccessForm gates
 * mounting; this component focuses on the offer UI + attach button.
 *
 * Visual treatment:
 *   - Lime-bordered card matching the success state's chrome so the
 *     attach reads as a continuation of the same celebratory beat.
 *   - "Already optional, never required" framing — never blocks the
 *     primary path back to the dashboard.
 *   - Cancel-anytime-before-day-31 reassurance is the LARGEST piece
 *     of supporting copy below the headline. Trial conversions live
 *     and die on whether buyers trust they won't be auto-charged.
 *
 * Tracking:
 *   - GA4 add_to_cart fires on click (before the API call) so we can
 *     measure attach-panel engagement separate from attach completion.
 *   - The success path fires `purchase` with $0 value (Stripe will
 *     fire the real $39 purchase event 30 days later via the
 *     subscription_data webhook).
 */
export function PulseAttachPanel({
  publicId,
  stripeCustomerId,
  originalSessionId,
}: PulseAttachPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    // GA4 attach-panel engagement event. Sliced separately from the
    // purchase event so we can compute (panel_view → add_to_cart →
    // purchase) drop-off in the funnel report.
    type GtagFn = (...args: unknown[]) => void;
    const w = window as unknown as { gtag?: GtagFn };
    if (typeof w.gtag === 'function') {
      w.gtag('event', 'add_to_cart', {
        currency: 'USD',
        value: 0, // trial — no charge today
        items: [
          {
            item_id: 'pulse_attach',
            item_name: 'TurfMap Pulse (30-day trial)',
            quantity: 1,
            price: 39, // monthly price post-trial
          },
        ],
      });
    }

    try {
      const res = await fetch('/api/checkout/pulse-attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicId,
          stripeCustomerId,
          originalSessionId,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? `Pulse attach failed (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setLoading(false);
    }
  };

  return (
    <div
      className="border rounded-lg p-6 md:p-8 mt-6 relative overflow-hidden"
      style={{
        background: 'var(--color-card-glow)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 30px #c5ff3a14',
      }}
    >
      {/* Eyebrow — frames the offer as add-on, not surprise upsell. */}
      <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
        <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
        <span style={{ color: 'var(--color-lime)' }}>
          Optional add-on
        </span>
        <span className="text-zinc-600">·</span>
        <span>30-day free trial</span>
      </div>

      <h3 className="font-display text-xl md:text-2xl font-bold leading-tight mb-2">
        Track your map weekly. <em>Free for 30 days.</em>
      </h3>

      <p className="text-sm md:text-base text-zinc-300 leading-relaxed mb-5 max-w-2xl">
        TurfMap Pulse re-scans your territory weekly so you catch
        ranking shifts the moment they happen. Add it now — first 30
        days are on us, then{' '}
        <strong className="font-semibold text-zinc-100">$39/mo</strong>.{' '}
        <strong className="font-semibold text-zinc-100">
          Cancel anytime before day 31 to pay nothing.
        </strong>
      </p>

      {/* Three-bullet feature row — what they actually get during the
       *  trial. Compact icons + one-line bodies so the panel doesn't
       *  bloat the success page. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <FeatureItem icon={RefreshCw} label="Weekly auto-rescan">
          Map refreshes every 7 days, automatically.
        </FeatureItem>
        <FeatureItem icon={Bell} label="Drop alerts">
          Email when your TurfScore moves more than ±5.
        </FeatureItem>
        <FeatureItem icon={TrendingUp} label="Trend chart">
          See your visibility curve build over time.
        </FeatureItem>
      </div>

      {/* CTA + cancel reassurance below. The reassurance line is the
       *  smaller line — the CTA is the focal point. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Check
            size={14}
            strokeWidth={2.5}
            style={{ color: 'var(--color-lime)' }}
          />
          <span>
            Card on file. No charge until day 31. Cancel anytime before
            then.
          </span>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={handleClick}
          disabled={loading}
          rightIcon={<ArrowRight size={14} strokeWidth={2.5} />}
          className="w-full sm:w-auto"
        >
          {loading ? 'Opening secure checkout…' : 'Add Pulse free for 30 days'}
        </Button>
      </div>

      {error && (
        <p
          className="mt-3 text-xs text-red-400 leading-relaxed"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** Single feature row inside the 3-column attach panel feature grid. */
function FeatureItem({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof RefreshCw;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={13} style={{ color: 'var(--color-lime)' }} />
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
        </div>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}
