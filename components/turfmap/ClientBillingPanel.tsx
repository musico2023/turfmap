'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  CreditCard,
  ExternalLink,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { tierLabel } from '@/lib/subscription/tier';
import type { SubscriptionTier } from '@/lib/supabase/types';

/**
 * Client-portal billing panel.
 *
 * Shown only when the client is on a recurring subscription (Pulse or
 * Pulse+). Surfaces:
 *   - Current tier (badge) + status
 *   - Next billing date
 *   - "Manage billing" button — opens the Stripe Customer Portal
 *     (invoices, payment methods, cancellation)
 *   - "Upgrade to Pulse+" button — only when tier='pulse'; opens an
 *     inline upgrade flow that hits /api/portal/upgrade and redirects
 *     to the portal's payment-method update page so Stripe captures
 *     any prorated charge cleanly.
 *
 * Renders nothing for one_time clients — they bought a one-shot
 * product and have no recurring billing relationship to manage.
 */
export type ClientBillingPanelProps = {
  /** Client UUID — passed to /api/portal/* endpoints. */
  clientId: string;
  /** Client public_id — passed to /api/portal/cancel-pulse-trial,
   *  which keys lookups by public_id. Same value as the slug in
   *  the portal URL. */
  clientPublicId: string;
  tier: SubscriptionTier | null;
  /** Server-loaded subscription summary. NULL when the client has no
   *  Stripe subscription on file (agency-managed) — panel renders
   *  read-only tier info in that case. */
  summary:
    | {
        ok: true;
        status: string;
        currentPeriodEnd: string;
        cancelAtPeriodEnd: boolean;
        minimumCommitmentEnd: string | null;
        inCommittedPhase: boolean;
      }
    | { ok: false; kind: string; message: string }
    | null;
};

export function ClientBillingPanel({
  clientId,
  clientPublicId,
  tier,
  summary,
}: ClientBillingPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<'portal' | 'upgrade' | 'cancel' | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);

  // Auto-open the cancel-trial modal when the buyer arrives via the
  // day-28 email's "Cancel trial" deep link (?cancel_trial=1). The
  // searchParams check fires once on mount; closing the modal won't
  // re-open it since there's no observer wired up. Only opens when
  // the buyer is actually in trial state — otherwise we'd open a
  // modal that posts an API that 400s.
  useEffect(() => {
    if (
      searchParams?.get('cancel_trial') === '1' &&
      summary &&
      summary.ok &&
      summary.status === 'trialing' &&
      !summary.cancelAtPeriodEnd
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only effect (mount/hydration guard, timer, or external-store sync) — not derivable during render
      setCancelModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isTrialing = summary?.ok && summary.status === 'trialing';
  const cancelAlreadyScheduled =
    summary?.ok && summary.cancelAtPeriodEnd;

  const openBillingPortal = async () => {
    setError(null);
    setNotice(null);
    setBusy('portal');
    try {
      const res = await fetch('/api/portal/billing-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? `unable to open billing portal (HTTP ${res.status})`);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelPulseTrial = async () => {
    setError(null);
    setNotice(null);
    setBusy('cancel');
    try {
      const res = await fetch('/api/portal/cancel-pulse-trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientPublicId }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        cancelsAt?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(
          data.error ?? `Cancellation failed (HTTP ${res.status})`
        );
        return;
      }
      // Show a brief inline confirmation, then refresh to pick up the
      // new cancelAtPeriodEnd flag from Stripe (the summary will
      // re-render with the "Access ends YYYY-MM-DD" amber banner).
      setNotice(
        data.cancelsAt
          ? `Cancellation scheduled — your trial ends ${data.cancelsAt.slice(0, 10)} with no charge.`
          : 'Cancellation scheduled — no charge will run at trial end.'
      );
      setCancelModalOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const upgradeToPulsePlus = async () => {
    setError(null);
    setNotice(null);
    setBusy('upgrade');
    try {
      const res = await fetch('/api/portal/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? `upgrade failed (HTTP ${res.status})`);
        return;
      }
      setNotice('You’re now on Pulse+. Pulse+ features unlock on your next page refresh.');
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tierBadge = (
    <span
      className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold whitespace-nowrap"
      style={{
        background:
          tier === 'pulse_plus'
            ? 'rgba(197, 255, 58, 0.12)'
            : 'rgba(255, 255, 255, 0.04)',
        color:
          tier === 'pulse_plus'
            ? 'var(--color-lime, #c5ff3a)'
            : '#a1a1aa',
        border: `1px solid ${
          tier === 'pulse_plus'
            ? 'rgba(197, 255, 58, 0.3)'
            : 'rgba(255, 255, 255, 0.1)'
        }`,
      }}
    >
      {tierLabel(tier)}
    </span>
  );

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="font-display text-lg font-bold flex items-center gap-2">
            <CreditCard size={15} className="text-zinc-400" />
            Billing
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-md">
            Your subscription, invoices, and payment methods. Managed
            through Stripe.
          </p>
        </div>
        {tierBadge}
      </div>

      {summary && summary.ok && (
        <div className="space-y-2.5 mb-4">
          <Row label="Status" value={pretty(summary.status)} />
          <Row
            label={
              summary.cancelAtPeriodEnd ? 'Access ends' : 'Next billing'
            }
            value={summary.currentPeriodEnd.slice(0, 10)}
          />
          {summary.cancelAtPeriodEnd && (
            <div
              className="rounded border px-3 py-2 text-xs"
              style={{
                background: 'rgba(255, 159, 58, 0.06)',
                borderColor: 'rgba(255, 159, 58, 0.3)',
                color: '#ffb86b',
              }}
            >
              Cancellation scheduled — access ends{' '}
              {summary.currentPeriodEnd.slice(0, 10)}.
            </div>
          )}
          {summary.inCommittedPhase && summary.minimumCommitmentEnd && (
            <div
              className="rounded border px-3 py-2 text-xs"
              style={{
                background: 'var(--color-card-glow)',
                borderColor: 'var(--color-border-bright)',
                color: 'var(--color-lime)',
              }}
            >
              <strong>Minimum commitment ends</strong>{' '}
              {summary.minimumCommitmentEnd.slice(0, 10)}.
            </div>
          )}
        </div>
      )}

      {summary && !summary.ok && (
        <p className="text-xs text-zinc-500 italic mb-4">
          Subscription details temporarily unavailable.
        </p>
      )}

      {!summary && (
        <p className="text-xs text-zinc-500 italic mb-4">
          Billing managed by your account team. Contact support for
          changes.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* During an active Pulse trial, the most prominent action is
         *  "Cancel Pulse trial" — it's the affordance the day-28
         *  email points at and the one buyers will look for first.
         *  Suppress when cancellation is already scheduled (the amber
         *  banner above already conveys the state). */}
        {isTrialing && !cancelAlreadyScheduled && (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setCancelModalOpen(true)}
            disabled={busy !== null}
            leftIcon={<X size={12} strokeWidth={2.5} />}
          >
            Cancel Pulse trial
          </Button>
        )}
        {summary && summary.ok && (
          <Button
            variant="secondary"
            size="md"
            onClick={openBillingPortal}
            loading={busy === 'portal'}
            loadingLabel="Opening…"
            disabled={busy !== null}
            leftIcon={<ExternalLink size={12} />}
          >
            Manage billing
          </Button>
        )}
        {tier === 'pulse' && summary && summary.ok && !isTrialing && (
          <Button
            variant="primary"
            size="md"
            onClick={upgradeToPulsePlus}
            loading={busy === 'upgrade'}
            loadingLabel="Upgrading…"
            disabled={busy !== null}
            leftIcon={<Sparkles size={12} />}
          >
            Upgrade to Pulse+
          </Button>
        )}

        {error && (
          <span className="text-xs text-red-400 font-mono ml-auto">
            {error}
          </span>
        )}
        {!error && notice && (
          <span
            className="text-xs font-mono ml-auto flex items-center gap-1"
            style={{ color: 'var(--color-lime)' }}
          >
            <Activity size={11} />
            {notice}
          </span>
        )}
      </div>

      {/* Cancel-trial confirmation modal. Backdrop + centered card.
       *  Fires on either the dashboard "Cancel Pulse trial" button OR
       *  the day-28 email's deep link (?cancel_trial=1 auto-opens
       *  this on mount). Single confirm click cancels; close button
       *  + ESC + backdrop click all dismiss. Sub-2-second flow per
       *  the launch checklist. */}
      {cancelModalOpen && (
        <CancelTrialModal
          busy={busy === 'cancel'}
          summary={summary && summary.ok ? summary : null}
          onConfirm={cancelPulseTrial}
          onClose={() => {
            if (busy === 'cancel') return;
            setCancelModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal-style confirm dialog for cancelling the Pulse trial. Inline
 * fixed-position layout — no portal/dialog dependency — keeps the
 * component zero-dependency (Tailwind + lucide already in the
 * bundle).
 */
function CancelTrialModal({
  busy,
  summary,
  onConfirm,
  onClose,
}: {
  busy: boolean;
  summary: {
    currentPeriodEnd: string;
  } | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // ESC closes the modal. Lives only while the modal is mounted, so
  // no leaked listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.65)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-trial-title"
    >
      <div
        className="border rounded-lg max-w-md w-full p-6 relative"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border-bright)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute top-3 right-3 text-zinc-500 hover:text-zinc-300 transition-colors p-1 disabled:opacity-50"
        >
          <X size={16} />
        </button>

        <h3
          id="cancel-trial-title"
          className="font-display text-lg font-bold mb-2"
        >
          Cancel your Pulse trial?
        </h3>
        <p className="text-sm text-zinc-300 leading-relaxed mb-2">
          You&rsquo;ll keep Pulse access through the end of your trial
          {summary?.currentPeriodEnd && (
            <>
              {' '}(
              <strong className="text-zinc-100">
                {summary.currentPeriodEnd.slice(0, 10)}
              </strong>
              )
            </>
          )}
          , and your card{' '}
          <strong className="text-zinc-100">won&rsquo;t be charged</strong>.
        </p>
        <p className="text-xs text-zinc-500 leading-relaxed mb-5">
          Changed your mind? Re-activate anytime from the billing page
          before your trial ends.
        </p>

        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={busy}
          >
            Keep Pulse
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onConfirm}
            loading={busy}
            loadingLabel="Cancelling…"
            disabled={busy}
          >
            Yes, cancel trial
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
        {label}
      </span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function pretty(status: string): string {
  if (!status) return '—';
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}
