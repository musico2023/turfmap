'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Agency-dashboard surface for self-serve subscription state.
 *
 * Shown on the settings page for clients with billing_mode =
 * 'self_serve_subscription'. Surfaces:
 *   - Current status (active / trialing / past_due / etc.)
 *   - Next billing date (current_period_end)
 *   - Whether cancellation is already scheduled
 *   - For Pulse+ monthly buyers in their 3-month committed phase:
 *     "Minimum commitment ends YYYY-MM-DD. Cancellation will take
 *     effect on that date." — and the cancel button is locked.
 *
 * Data is loaded by the server-side wrapper (page.tsx) via
 * loadSubscriptionSummary; this component just renders it + handles
 * the cancel-button click.
 */

export type SubscriptionPanelProps = {
  clientId: string;
  /** Server-loaded subscription state. Null when no subscription
   *  exists OR Stripe isn't yet configured — panel renders a
   *  placeholder copy in that case. */
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

export function SubscriptionPanel({
  clientId,
  summary,
}: SubscriptionPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onCancel = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch('/api/subscription/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        cancels_at?: string;
        error?: string;
        kind?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `cancel failed (HTTP ${res.status})`);
        return;
      }
      setNotice(
        `Cancellation scheduled for ${data.cancels_at ? data.cancels_at.slice(0, 10) : 'end of period'}.`
      );
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4">
        <h3 className="font-display text-lg font-bold">Subscription</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          Self-serve billing state. Cancellation always takes effect
          at the end of the current period — never instant.
        </p>
      </div>

      {!summary && (
        <PlaceholderRow message="Subscription details will appear here once Stripe is configured + the order-fulfill flow has run." />
      )}

      {summary && !summary.ok && summary.kind === 'stripe_not_configured' && (
        <PlaceholderRow message="Subscription management is offline until STRIPE_SECRET_KEY is set in your environment." />
      )}

      {summary && !summary.ok && summary.kind !== 'stripe_not_configured' && (
        <div className="text-xs text-red-400 font-mono">
          {summary.message}
        </div>
      )}

      {summary && summary.ok && (
        <div className="space-y-3">
          <Row label="Status" value={pretty(summary.status)} />
          <Row
            label="Next billing"
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
              {summary.minimumCommitmentEnd.slice(0, 10)}.{' '}
              <span className="text-zinc-300">
                Cancellation will take effect on that date.
              </span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            {error && (
              <span className="text-xs text-red-400 font-mono mr-auto">
                {error}
              </span>
            )}
            {!error && notice && (
              <span
                className="text-xs font-mono mr-auto"
                style={{ color: 'var(--color-lime)' }}
              >
                ✓ {notice}
              </span>
            )}
            <Button
              variant="secondary"
              size="md"
              onClick={onCancel}
              disabled={
                busy ||
                summary.cancelAtPeriodEnd ||
                summary.inCommittedPhase
              }
              loading={busy}
              loadingLabel="Scheduling…"
              leftIcon={
                summary.inCommittedPhase ? (
                  <Lock size={12} />
                ) : (
                  <Activity size={12} />
                )
              }
            >
              {summary.cancelAtPeriodEnd
                ? 'Cancellation pending'
                : summary.inCommittedPhase
                  ? 'Locked until minimum ends'
                  : 'Cancel at period end'}
            </Button>
          </div>
        </div>
      )}
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

function PlaceholderRow({ message }: { message: string }) {
  return (
    <p className="text-xs text-zinc-500 italic leading-relaxed">{message}</p>
  );
}

function pretty(status: string): string {
  if (!status) return '—';
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}
