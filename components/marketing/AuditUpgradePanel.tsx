'use client';

import { useState } from 'react';
import { ArrowRight, Check, Clock } from 'lucide-react';

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
   *  no-redirect "Confirm \$197 charge to **** 4242" button that
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
      {/* Eyebrow strip — small lime-accented header to differentiate
       *  from the (sibling) Pulse-attach panel which uses its own
       *  amber/orange treatment. */}
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
        <span style={{ color: 'var(--color-lime)' }}>●</span>
        <span style={{ color: 'var(--color-lime)' }}>
          Visibility Audit upgrade
        </span>
        <span className="text-zinc-600">·</span>
        <span>$499 → $197 (24h window)</span>
      </div>

      <h3 className="font-display text-xl md:text-2xl font-bold mb-3">
        {headline}
      </h3>

      <p className="text-zinc-300 text-sm md:text-base leading-relaxed mb-5">
        {leadCopy}
      </p>

      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-3">
        What you get with the upgrade
      </div>

      <ul className="space-y-2 mb-5">
        {[
          source === 'dashboard'
            ? '30-min strategist call within 5 business days'
            : '30-min strategist diagnostic call (live competitor teardown)',
          source === 'dashboard'
            ? 'Competitor heatmap analysis of your top 3 territory threats'
            : 'Per-vertical NAP audit (every directory specific to your trade)',
          source === 'dashboard'
            ? null
            : 'Competitor analysis with heatmap overlay',
          '90-Day Visibility Roadmap PDF (week-by-week action plan)',
          '30-day re-scan + 60-day strategist check-in call',
          'TurfScore Lift Promise: minimum 10-point lift, or we redo it free',
        ]
          .filter(Boolean)
          .map((line) => (
            <li
              key={line as string}
              className="flex items-start gap-2.5 text-sm text-zinc-200 leading-relaxed"
            >
              <Check
                size={14}
                strokeWidth={2.5}
                className="flex-shrink-0 mt-0.5"
                style={{ color: 'var(--color-lime)' }}
              />
              <span>{line}</span>
            </li>
          ))}
      </ul>

      {/* Pricing line — bold framing on the credit math. */}
      <div className="mb-3">
        <p className="text-sm md:text-base text-zinc-300 leading-relaxed">
          <strong className="text-zinc-100">
            Normally $499. Upgrade now: $197
          </strong>{' '}
          <span className="text-zinc-500">
            (your $49 already counted).
          </span>
        </p>
      </div>

      {/* Time-window callout */}
      <div className="flex items-center gap-2 mb-5 text-xs text-zinc-400 font-mono">
        <Clock size={12} style={{ color: 'var(--color-lime)' }} />
        <span>
          {timeRemainingLabel ??
            (source === 'order_success'
              ? 'Special pricing for the next 24 hours only'
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

      {/* CTA + skip affordance */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md text-sm font-semibold transition-colors disabled:opacity-50"
          style={{
            background: 'var(--color-lime)',
            color: '#000',
          }}
        >
          {busy
            ? savedCard
              ? 'Processing payment…'
              : 'Opening checkout…'
            : savedCard
              ? 'Confirm $197 charge'
              : 'Add the Roadmap → $197'}
          {!busy && <ArrowRight size={14} strokeWidth={2.5} />}
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
