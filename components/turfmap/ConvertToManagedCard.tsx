'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { SubscriptionTier } from '@/lib/supabase/types';

/**
 * Agency-side "convert to agency-managed" card.
 *
 * Renders only on self_serve_subscription clients with a Stripe
 * subscription. Lets the operator wind down the Stripe sub and flip
 * the row to agency_managed in one shot — for the case where a buyer
 * who came in via the marketing tripwire ($39/$89 self-serve) gets
 * upgraded to a Local Lead Machine custom contract.
 *
 * Two-step UX: button → inline confirmation form (tier + cancel
 * timing) → destructive-styled confirm. We don't show a modal; the
 * inline expansion mirrors the same pattern as DeleteClientCard +
 * the rest of the agency settings cards.
 *
 * Cancellation timing:
 *   - "period_end": buyer keeps their paid period, sub auto-ends at
 *     next billing date. Cleanest, no refund. Default.
 *   - "now": cancel immediately. Operator handles any prorated
 *     refund manually in the Stripe dashboard.
 */
export type ConvertToManagedCardProps = {
  /** Client UUID — passed to /api/clients/[id]/convert-to-managed. */
  clientId: string;
  /** Current tier — used as the default in the picker. NULL falls
   *  back to 'pulse_plus' (the typical agency-contract bundle). */
  currentTier: SubscriptionTier | null;
};

export function ConvertToManagedCard({
  clientId,
  currentTier,
}: ConvertToManagedCardProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [tier, setTier] = useState<SubscriptionTier>(
    currentTier ?? 'pulse_plus'
  );
  const [cancelTiming, setCancelTiming] = useState<'now' | 'period_end'>(
    'period_end'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/convert-to-managed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, cancel_timing: cancelTiming }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        cancel?: { canceled: boolean; cancelsAt?: string; note?: string };
      };
      if (!res.ok) {
        setError(data.error ?? `convert failed (HTTP ${res.status})`);
        return;
      }
      // Success — refresh the page. The card itself unmounts because
      // billing_mode is now agency_managed, which is its own gate.
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-lg font-bold flex items-center gap-2">
            <Briefcase size={15} className="text-zinc-400" />
            Convert to agency-managed
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-xl">
            For when this self-serve buyer is now on a custom Local
            Lead Machine contract billed outside Stripe. Cancels their
            Stripe subscription, flips billing_mode to agency_managed,
            and sets tier explicitly. The Stripe webhook stops
            overwriting tier post-conversion.
          </p>
        </div>
        {!expanded && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setExpanded(true)}
            className="flex-shrink-0"
          >
            Convert
          </Button>
        )}
      </div>

      {expanded && (
        <div
          className="mt-4 pt-4 border-t space-y-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div>
            <label className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5">
              Tier under agency contract
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={tier === 'pulse' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTier('pulse')}
                disabled={busy}
              >
                Pulse
              </Button>
              <Button
                type="button"
                variant={tier === 'pulse_plus' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTier('pulse_plus')}
                disabled={busy}
              >
                Pulse+
              </Button>
              <span className="text-[11px] text-zinc-600 ml-2">
                Most agency contracts bundle Pulse+ since it includes
                citations.
              </span>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5">
              Cancel Stripe subscription
            </label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="cancel-timing"
                  value="period_end"
                  checked={cancelTiming === 'period_end'}
                  onChange={() => setCancelTiming('period_end')}
                  disabled={busy}
                  className="mt-1 accent-[var(--color-lime)]"
                />
                <span className="text-zinc-200">
                  At end of current period{' '}
                  <span className="text-zinc-500">
                    (buyer keeps paid time, no refund)
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="cancel-timing"
                  value="now"
                  checked={cancelTiming === 'now'}
                  onChange={() => setCancelTiming('now')}
                  disabled={busy}
                  className="mt-1 accent-[var(--color-lime)]"
                />
                <span className="text-zinc-200">
                  Immediately{' '}
                  <span className="text-zinc-500">
                    (refund unused time manually in Stripe dashboard)
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              background: 'rgba(255, 159, 58, 0.05)',
              borderColor: 'rgba(255, 159, 58, 0.3)',
              color: '#ffb86b',
            }}
          >
            This is one-way. To return the client to self-serve
            billing later, you&rsquo;d need them to complete a fresh
            Stripe Checkout.
          </div>

          {error && (
            <div className="text-xs text-red-400 font-mono">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => setExpanded(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="md"
              onClick={onConfirm}
              loading={busy}
              loadingLabel="Converting…"
              leftIcon={<Activity size={12} />}
            >
              Convert to agency-managed
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
