'use client';

import { useState } from 'react';
import { ArrowRight, Check, Clock, Shield } from 'lucide-react';

/**
 * Visibility Audit upgrade panel — shown to TurfScan buyers within
 * 24 hours of purchase to upsell into the $197 audit (= $499 list
 * minus the $302 UPGRADE_302_CREDIT promo, framed as "your $49
 * already counted").
 *
 * Two placements use this component with different `source` values:
 *
 *   "order_success" — rendered on /order/success between the
 *     success card and the Pulse-attach panel. Does NOT have a
 *     dynamic time-remaining countdown because the buyer just
 *     completed payment seconds ago; the 24h window is implicit.
 *
 *   "dashboard" — rendered on /portal/<id> beneath the Fix List.
 *     Surfaces a more contextualized pitch tied to the buyer's
 *     actual TurfScore + a live countdown to the 24h cutoff.
 *
 * Server-side gating: the dashboard placement should only render
 * this component when within the 24h window — that's enforced by
 * the parent component (DashboardAuditUpgradeBanner) which checks
 * scan.completed_at vs. NOW(). Order-success placement is always
 * within window (just-purchased) so no client-side check.
 *
 * Click → POST /api/upgrade/audit/create-session → redirect to
 * the returned Stripe Checkout URL. The endpoint validates the
 * 24h window server-side too; this client check is just for UI.
 */

export type AuditUpgradePanelProps = {
  /** Where this instance is being rendered. Forwarded to the
   *  upgrade endpoint so the cancel_url routes back correctly + the
   *  Stripe metadata records which placement converted. */
  source: 'order_success' | 'dashboard';
  /** For source=order_success: the original TurfScan checkout
   *  session id from /order/success?session_id=...
   *  For source=dashboard: omit; pass clientId instead. */
  sessionId?: string;
  /** For source=dashboard: the client UUID. The endpoint resolves
   *  the most recent scan-tier lead_order from this. Omit on
   *  order_success. */
  clientId?: string;
  /** Buyer's current TurfScore. Used in the dashboard placement's
   *  contextual headline ("Your TurfScore is X"). Optional on
   *  order_success since the score isn't computed yet. */
  currentScore?: number | null;
  /** Time remaining in the upgrade window. Pre-formatted by the
   *  caller (e.g. "23h 14m left"). Dashboard placement only;
   *  optional on order-success. */
  timeRemainingLabel?: string;
  /** Order-success only. Fired when the buyer declines the upgrade
   *  and chooses to proceed to their TurfMap. The parent uses this
   *  to reveal the "Your TurfMap is ready" success card, which is
   *  hidden by default while the upgrade decision is pending so the
   *  two CTAs don't compete. No-op on dashboard placement. */
  onSkip?: () => void;
  /** Order-success only. The buyer's saved Stripe card (from the
   *  original scan purchase). When present, panel renders a
   *  no-redirect "Upgrade now" button (charges the saved card) that
   *  fires /api/upgrade/audit/confirm. When null, falls back to
   *  Stripe Checkout redirect via /create-session. */
  savedCard?: { brand: string; last4: string } | null;
  /** Order-success only. Fired when the inline confirm succeeds
   *  (no Stripe redirect). Parent transitions state to show the
   *  audit-purchased banner + intake form. No-op when the panel
   *  falls back to Stripe Checkout redirect (the Stripe flow
   *  redirects away, then the page reloads with ?upgrade=audit
   *  which the parent reads separately). */
  onInlineConfirmSuccess?: () => void;
};

export function AuditUpgradePanel({
  source,
  sessionId,
  clientId,
  currentScore,
  timeRemainingLabel,
  onSkip,
  savedCard,
  onInlineConfirmSuccess,
}: AuditUpgradePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setError(null);

    // Fire GA4 event before redirect so the click attribution
    // lands even if Stripe takes a beat. gtag may not be available
    // in dev; guard the call.
    type GtagFn = (...args: unknown[]) => void;
    const w = window as unknown as { gtag?: GtagFn };
    if (typeof w.gtag === 'function') {
      w.gtag('event', 'audit_upgrade_clicked', {
        upgrade_placement: source,
        currency: 'USD',
        value: 197,
      });
    }

    // Meta Pixel AddToCart — fires on the upgrade-attempt click (not
    // success). Mirrors the GA `audit_upgrade_clicked` payload so the
    // two analytics stacks track in parallel. Gated on
    // NEXT_PUBLIC_META_PIXEL_ID via the helper — no-op when unset.
    try {
      const { trackMetaEvent } = await import(
        '@/components/marketing/scan/MetaPixel'
      );
      trackMetaEvent('AddToCart', {
        currency: 'USD',
        value: 197,
        content_name: 'Visibility Audit',
        content_category: 'upgrade',
        upgrade_placement: source,
      });
    } catch {
      // Pixel import failed — swallow. Upgrade proceeds.
    }

    try {
      // 1-click path: when the buyer has a saved card from the
      // scan purchase, fire the inline PaymentIntent confirm. No
      // Stripe Checkout redirect — the audit upgrade processes in
      // a single API call. On `fallback_to_checkout`, fall through
      // to the redirect-style flow (covers 3DS challenges + edge
      // cases where the inline path can't proceed).
      if (savedCard && source === 'order_success' && sessionId) {
        const confirmRes = await fetch('/api/upgrade/audit/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source,
            session_id: sessionId,
          }),
        });
        const confirmData = (await confirmRes.json()) as {
          ok?: boolean;
          fallback_to_checkout?: boolean;
          reason?: string;
          error?: string;
          payment_intent_id?: string;
        };
        if (confirmData.ok) {
          // Success! Notify parent so it transitions to the
          // post-upgrade state (intake form + audit-purchased
          // banner). No redirect needed.
          if (onInlineConfirmSuccess) onInlineConfirmSuccess();
          setBusy(false);
          return;
        }
        if (!confirmData.fallback_to_checkout) {
          // Hard error — surface it.
          setError(confirmData.error ?? `Upgrade failed (${confirmRes.status})`);
          setBusy(false);
          return;
        }
        // Fallback path: continue to create-session below.
      }

      const res = await fetch('/api/upgrade/audit/create-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source,
          session_id: sessionId,
          client_id: clientId,
        }),
      });
      const data = (await res.json()) as {
        checkout_url?: string;
        error?: string;
      };
      if (!res.ok || !data.checkout_url) {
        setError(data.error ?? `Upgrade failed (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = data.checkout_url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setBusy(false);
    }
  }

  // Headline + lead copy switches by placement. Order-success is
  // forward-looking ("your scan is firing now"); dashboard is
  // results-aware ("your TurfScore is X").
  const headline =
    source === 'dashboard' && currentScore != null
      ? `Your TurfScore is ${currentScore}.`
      : 'Add a 90-day Roadmap to your scan?';

  const leadCopy =
    source === 'dashboard' ? (
      <>
        The Fix List above shows you what to do, but:
        <br />— Executing those actions in the right sequence takes
        judgment.
        <br />— Ranking up requires more than just the 3 highest-impact
        moves.
        <br />— Most operators leave 60–80% of potential lift on the
        table.
        <br />
        <br />
        Want a TurfMap strategist to build a 90-day implementation plan?
      </>
    ) : (
      <>
        Your TurfScan is firing now. Want a TurfMap strategist to build
        a 90-day implementation plan based on what we find?
      </>
    );

  return (
    <div
      className="border rounded-lg p-6 md:p-7 mb-6"
      style={{
        background: 'var(--color-card-glow)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 24px #c5ff3a14',
      }}
    >
      {/* Eyebrow strip — lime-accented + price-anchor savings badge.
       *  Strong color contrast on "SAVE $302" makes the discount the
       *  first thing the eye lands on, not the small-print clock. */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] font-mono font-semibold">
        <span style={{ color: 'var(--color-lime)' }}>●</span>
        <span style={{ color: 'var(--color-lime)' }}>
          Visibility Audit upgrade
        </span>
        <span className="text-zinc-700">·</span>
        <span
          className="px-2 py-0.5 rounded-sm text-black"
          style={{ background: 'var(--color-lime)' }}
        >
          Save $302
        </span>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-500">24h window</span>
      </div>

      <h3 className="font-display text-xl md:text-2xl font-bold mb-3 text-white">
        {headline}
      </h3>

      <p className="text-zinc-300 text-sm md:text-base leading-relaxed mb-5">
        {leadCopy}
      </p>

      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-3">
        What you get with the upgrade
      </div>

      {/* Standard deliverables — TurfScore Lift Promise is pulled OUT
       *  to its own callout below because it's the risk-reversal
       *  hero, not just another bullet. Bolded value-fragments help
       *  the buyer's scan-pattern catch the differentiators. */}
      <ul className="space-y-2.5 mb-5">
        {(source === 'dashboard'
          ? [
              <>
                <strong className="text-white">30-min strategist call</strong>{' '}
                within 5 business days
              </>,
              <>
                <strong className="text-white">
                  Competitor heatmap analysis
                </strong>{' '}
                of your top 3 territory threats
              </>,
              <>
                <strong className="text-white">
                  90-Day Visibility Roadmap PDF
                </strong>{' '}
                (week-by-week action plan)
              </>,
              <>
                <strong className="text-white">30-day re-scan</strong> +{' '}
                <strong className="text-white">
                  60-day strategist check-in
                </strong>{' '}
                call
              </>,
            ]
          : [
              <>
                <strong className="text-white">
                  30-min strategist diagnostic call
                </strong>{' '}
                (live competitor teardown)
              </>,
              <>
                <strong className="text-white">Per-vertical NAP audit</strong>{' '}
                (every directory specific to your trade)
              </>,
              <>
                <strong className="text-white">Competitor analysis</strong>{' '}
                with heatmap overlay
              </>,
              <>
                <strong className="text-white">
                  90-Day Visibility Roadmap PDF
                </strong>{' '}
                (week-by-week action plan)
              </>,
              <>
                <strong className="text-white">30-day re-scan</strong> +{' '}
                <strong className="text-white">
                  60-day strategist check-in
                </strong>{' '}
                call
              </>,
            ]
        ).map((line, i) => (
          <li
            key={i}
            className="flex items-start gap-2.5 text-sm text-zinc-300 leading-relaxed"
          >
            <Check
              size={15}
              strokeWidth={3}
              className="flex-shrink-0 mt-0.5"
              style={{ color: 'var(--color-lime)' }}
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {/* TurfScore Lift Promise — risk reversal hero. Pulled out of
       *  the bullet list so it gets its own callout: shield icon,
       *  lime border, distinct heading. This is the strongest
       *  conversion lever (money-back guarantee) and was previously
       *  buried as the 6th bullet. */}
      <div
        className="rounded-md border-2 px-4 py-3 mb-5 flex items-start gap-3"
        style={{
          background: 'rgba(197, 255, 58, 0.05)',
          borderColor: 'rgba(197, 255, 58, 0.35)',
        }}
      >
        <Shield
          size={18}
          strokeWidth={2.25}
          className="flex-shrink-0 mt-0.5"
          style={{ color: 'var(--color-lime)' }}
        />
        <div className="text-sm leading-relaxed">
          <div
            className="text-[10px] uppercase tracking-[0.18em] font-mono font-bold mb-1"
            style={{ color: 'var(--color-lime)' }}
          >
            TurfScore Lift Promise
          </div>
          <div className="text-zinc-200">
            Implement the plan within 14 days. If you don&rsquo;t gain{' '}
            <strong className="text-white">+10 TurfScore points</strong>{' '}
            in 90 days,{' '}
            <strong className="text-white">we refund the full cost</strong>.
          </div>
        </div>
      </div>

      {/* Pricing display — strong visual hierarchy. $197 is the
       *  attention anchor; $499 strikethrough is supporting context;
       *  "you save $302" reinforces below. Previous version had both
       *  prices in the same bold weight which made the discount
       *  invisible to a scanner. */}
      <div className="mb-4 flex items-baseline gap-3 flex-wrap">
        <span className="font-display text-3xl md:text-4xl font-bold text-white">
          $197
        </span>
        <span className="text-base md:text-lg text-zinc-500 line-through font-mono">
          $499
        </span>
        <span
          className="text-sm font-semibold"
          style={{ color: 'var(--color-lime)' }}
        >
          Save $302 today
        </span>
      </div>

      {/* Time-window callout — stronger amber-style treatment so the
       *  scarcity registers. Previous version was muted gray text
       *  that visually receded; conversion benefits from this being
       *  one of the loudest elements on the panel. */}
      <div
        className="flex items-center gap-2 mb-5 text-xs font-mono font-semibold px-3 py-2 rounded-md border"
        style={{
          background: 'rgba(197, 255, 58, 0.08)',
          borderColor: 'rgba(197, 255, 58, 0.25)',
          color: 'var(--color-lime)',
        }}
      >
        <Clock size={13} strokeWidth={2.5} />
        <span>
          {timeRemainingLabel ??
            (source === 'order_success'
              ? 'Special pricing — next 24 hours only'
              : 'Upgrade window closes soon — after that, $499 from scratch')}
        </span>
      </div>

      {/* Saved-card row — only shown in the 1-click flow.
       *  Surfaces what card will be charged so the buyer trusts
       *  the no-redirect confirmation. */}
      {savedCard && source === 'order_success' && (
        <div
          className="flex items-center gap-2 mb-4 text-xs text-zinc-500 font-mono px-3 py-2 rounded-md border"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
          }}
        >
          <span className="text-zinc-600">Paying with</span>
          <span className="text-zinc-300 uppercase">
            {savedCard.brand}
          </span>
          <span className="text-zinc-600">ending</span>
          <span className="text-zinc-300">{savedCard.last4}</span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-600">1-click charge</span>
        </div>
      )}

      {/* CTA + skip affordance. Button is intentionally larger (px-7,
       *  py-3.5, base font, full-width on mobile) for a $197 commit —
       *  small CTAs read as low-importance regardless of color. Hover
       *  brightness lift gives a tactile cue that the button is
       *  interactive. */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-md text-base font-bold transition-all disabled:opacity-50 hover:brightness-110 w-full sm:w-auto"
          style={{
            background: 'var(--color-lime)',
            color: '#000',
            boxShadow: '0 6px 20px #c5ff3a40',
          }}
        >
          {busy
            ? savedCard
              ? 'Processing payment…'
              : 'Opening checkout…'
            : savedCard
              ? 'Upgrade now'
              : 'Add the Roadmap'}
          {!busy && <ArrowRight size={16} strokeWidth={3} />}
        </button>
        {source === 'order_success' && (
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="inline-flex items-center justify-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50 px-2 py-1"
          >
            Skip — open my TurfMap →
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-400 leading-relaxed" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
