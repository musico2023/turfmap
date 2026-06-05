'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Calendar,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type PulseAttachPanelProps = {
  /** Existing client public_id from the just-completed fulfillment.
   *  Used by /api/checkout/pulse-attach to validate the (publicId,
   *  stripeCustomerId) pair against the clients table. Also used as
   *  the default destination for the "Skip" link (→ /portal/<publicId>)
   *  when onSkip is not provided. */
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
  /** Optional handler for the "Skip" affordance. When provided, the
   *  skip control becomes a button that calls this callback (no
   *  navigation away) — used by the score_unlock sequenced flow on
   *  /order/success to reveal the next step (success card with
   *  heatmap CTA) on the same page. When absent, skip behaves as
   *  before: anchor link to /portal/<publicId>. */
  onSkip?: () => void;
  /** Label override for the skip control. Defaults to "Skip — open my
   *  TurfMap →" (correct when skip navigates to the portal). When the
   *  parent intercepts skip and reveals a heatmap-CTA card next,
   *  override to e.g. "Skip — see my heatmap →" for accuracy. */
  skipLabel?: string;
};

/**
 * Post-purchase Pulse trial-attach panel.
 *
 * Shipped as the primary visual element above the "Open my TurfMap"
 * CTA on /order/success — the trial is genuinely available, so the
 * language reflects activation rather than opt-in. Buyer still has
 * to click; the rhetorical shift just removes the "is this an upsell
 * I should suspect?" friction.
 *
 * Three GA4 events fire from this panel for funnel analysis:
 *   - attach_panel_shown   on mount (does the panel get seen?)
 *   - attach_panel_clicked on Activate CTA (start of trial flow)
 *   - attach_panel_skipped on the "Skip — open my TurfMap" link
 *
 * Without those three the funnel can't be sliced — we'd see Stripe
 * trial creation + paid conversion but not whether the panel itself
 * is converting at the 40-60% rate marketing wants.
 */
export function PulseAttachPanel({
  publicId,
  stripeCustomerId,
  originalSessionId,
  onSkip,
  skipLabel,
}: PulseAttachPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Panel-shown event fires once on mount. Independent from any
  // click — measures whether the buyer reached the panel at all
  // (i.e. didn't bail before scan-fulfill completed). Without it we
  // can't compute the (panel_shown → click) attach rate.
  useEffect(() => {
    type GtagFn = (...args: unknown[]) => void;
    const w = window as unknown as { gtag?: GtagFn };
    if (typeof w.gtag === 'function') {
      w.gtag('event', 'attach_panel_shown', {
        item_id: 'pulse_attach',
        item_name: 'TurfMap Pulse (30-day trial)',
        // GA4 event_category convention — groups all attach-panel
        // events under one funnel report bucket.
        event_category: 'pulse_attach',
      });
    }
  }, []);

  const fireGa = (event: string, extra: Record<string, unknown> = {}) => {
    type GtagFn = (...args: unknown[]) => void;
    const w = window as unknown as { gtag?: GtagFn };
    if (typeof w.gtag === 'function') {
      w.gtag('event', event, {
        item_id: 'pulse_attach',
        item_name: 'TurfMap Pulse (30-day trial)',
        event_category: 'pulse_attach',
        ...extra,
      });
    }
  };

  const handleActivate = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    fireGa('attach_panel_clicked', {
      currency: 'USD',
      value: 0, // trial — no charge today
      price_after_trial: 39,
    });

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

  const handleSkip = () => {
    fireGa('attach_panel_skipped');
    // Native navigation — the <a href> below will follow on its own,
    // we just fire the event as the buyer leaves. When onSkip is
    // provided (sequenced score_unlock flow), the parent has its
    // own click handler that preventDefaults and calls onSkip — we
    // still fire the GA event from this shared path so analytics
    // is consistent across both behaviors.
  };

  const handleSkipClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    handleSkip();
    if (onSkip) {
      e.preventDefault();
      onSkip();
    }
  };

  const resolvedSkipLabel = skipLabel ?? 'Skip — open my TurfMap';

  return (
    <div
      className="border rounded-lg p-6 md:p-8 relative overflow-hidden"
      style={{
        background: 'var(--color-card-glow)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 30px #c5ff3a14',
      }}
    >
      {/* Eyebrow — frames the trial as ready-to-claim, not an upsell.
       *  The "Free 30-day trial" + "$39/mo after" is also visible
       *  inline below the headline so the post-trial price is never
       *  hidden. */}
      <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
        <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
        <span style={{ color: 'var(--color-lime)' }}>
          Included with your purchase
        </span>
        <span className="text-zinc-600">·</span>
        <span>30-day Pulse trial</span>
      </div>

      <h3 className="font-display text-2xl md:text-3xl font-bold leading-tight mb-3">
        Your free 30-day Pulse trial is ready.
      </h3>

      <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-5 max-w-2xl">
        We&rsquo;ll re-scan you every Monday, alert you when your
        TurfScore moves, and refresh your AI Coach playbook each week.{' '}
        <strong className="font-semibold text-zinc-100">
          After 30 days, $39/mo. Cancel anytime.
        </strong>
      </p>

      {/* Three-bullet feature row — what they actually get during the
       *  trial. Compact icons + one-line bodies so the panel doesn't
       *  bloat the success page. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <FeatureItem icon={Calendar} label="Weekly scans">
          Map auto-refreshes every Monday morning.
        </FeatureItem>
        <FeatureItem icon={Bell} label="Drop alerts">
          Email when your TurfScore moves more than ±5.
        </FeatureItem>
        <FeatureItem icon={TrendingUp} label="Refreshed playbook">
          AI Coach revisits your fix list each week.
        </FeatureItem>
      </div>

      {/* Cost-savings anchor. Universal framing — a standalone
       *  TurfScan is $49 regardless of which tier the buyer just
       *  purchased, so the math holds for score_unlock, scan, audit,
       *  and strategy buyers alike. Positions Pulse as "less per
       *  scan than one-off" rather than "new monthly expense" —
       *  reframes the $39/mo as a quantity discount, not an upsell.
       *  Subtle treatment (mono price strikethrough + lime accent
       *  on the per-scan number) so it reads as math, not marketing. */}
      <div
        className="rounded-md border px-4 py-3 mb-6 flex items-start gap-3"
        style={{
          background: 'rgba(197, 255, 58, 0.04)',
          borderColor: 'rgba(197, 255, 58, 0.18)',
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold whitespace-nowrap mt-0.5"
          style={{ color: 'var(--color-lime)' }}
        >
          The math
        </div>
        <div className="text-xs leading-relaxed text-zinc-300">
          A one-off TurfScan is{' '}
          <span className="font-mono text-zinc-100">$49</span> each.
          Pulse runs <strong className="text-zinc-100">4 scans</strong>{' '}
          + weekly AI Coach refresh for{' '}
          <span className="font-mono text-zinc-100">$39/mo</span> —{' '}
          <strong style={{ color: 'var(--color-lime)' }}>
            under $10 per scan
          </strong>
          , billed monthly instead of per-scan.
        </div>
      </div>

      {/* Primary CTA + post-trial price reminder, then the skip link.
       *  CTA is the focal point; the post-trial price is repeated
       *  here in the immediate adjacency to the click so the buyer
       *  is reminded one last time before commit. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <Button
          type="button"
          variant="primary"
          size="lg"
          onClick={handleActivate}
          disabled={loading}
          rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
          className="w-full sm:w-auto"
        >
          {loading ? 'Opening secure checkout…' : 'Activate trial'}
        </Button>
        <div className="flex flex-col gap-1 text-xs text-zinc-500 leading-relaxed">
          <span className="flex items-center gap-1.5">
            <RefreshCw
              size={11}
              strokeWidth={2.25}
              style={{ color: 'var(--color-lime)' }}
            />
            <span>
              Free for 30 days, then{' '}
              <span className="text-zinc-300 font-semibold">$39/mo</span>.
              Cancel anytime.
            </span>
          </span>
          <span className="text-zinc-600">
            Card on file. No charge until day 31.
          </span>
        </div>
      </div>

      {/* Skip link — quietly affords bypassing the trial. The "Open
       *  my TurfMap" affordance lives only here in the attach-panel
       *  context (the standalone CTA is hidden when the panel is
       *  rendered to avoid double exits). Lower visual weight than
       *  the primary CTA. */}
      <div className="mt-5 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <a
          href={`/portal/${publicId}`}
          onClick={handleSkipClick}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          {resolvedSkipLabel}{' '}
          <ArrowRight size={11} strokeWidth={2} />
        </a>
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
