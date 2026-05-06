'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { SubscriptionTier } from '@/lib/supabase/types';

/**
 * Mirror of ConvertToManagedCard. Renders only on agency-managed
 * clients — moves them onto a Stripe-billed Pulse / Pulse+
 * subscription. Two-sided flow: this card initiates, but the buyer
 * completes Checkout on their end before the row is fully
 * activated.
 *
 * Inline two-step UX matching the rest of the agency settings
 * cards: button → expanded form (tier + buyer email + trial) →
 * confirm. On success the row flips to self_serve_subscription
 * with stripe_subscription_id null; the AwaitingPaymentSetupCard
 * takes over and shows the regenerate-link affordance until the
 * buyer completes Checkout.
 */
export type ConvertToSelfServeCardProps = {
  /** Client UUID — passed to /api/clients/[id]/convert-to-self-serve. */
  clientId: string;
  /** Current tier on the agency-managed row. Pre-fills the picker
   *  so the operator confirms-or-edits rather than retyping. */
  currentTier: SubscriptionTier | null;
};

export function ConvertToSelfServeCard({
  clientId,
  currentTier,
}: ConvertToSelfServeCardProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [tier, setTier] = useState<SubscriptionTier>(
    currentTier ?? 'pulse_plus'
  );
  const [buyerEmail, setBuyerEmail] = useState('');
  const [trialDays, setTrialDays] = useState<'0' | '7' | '14' | '30'>('14');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setError(null);
    if (!buyerEmail.trim()) {
      setError('Buyer email is required.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/convert-to-self-serve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier,
          buyer_email: buyerEmail.trim(),
          trial_days: Number(trialDays),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `convert failed (HTTP ${res.status})`);
        return;
      }
      // Success — refresh. The card unmounts (billing_mode is now
      // self_serve_subscription) and AwaitingPaymentSetupCard
      // surfaces with the Checkout-link copy + resend affordance.
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
            <CreditCard size={15} className="text-zinc-400" />
            Convert to self-serve subscription
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-xl">
            For when this agency-managed client is graduating to a
            Stripe-billed Pulse / Pulse+ subscription. Generates a
            Checkout link the buyer completes on their end —
            payment capture stays with Stripe.
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
              Tier
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={tier === 'pulse' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTier('pulse')}
                disabled={busy}
              >
                Pulse · $39/mo
              </Button>
              <Button
                type="button"
                variant={tier === 'pulse_plus' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTier('pulse_plus')}
                disabled={busy}
              >
                Pulse+ · $99/mo
              </Button>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5">
              Buyer email
            </label>
            <input
              type="email"
              value={buyerEmail}
              onChange={(e) => setBuyerEmail(e.target.value)}
              placeholder="owner@business.com"
              disabled={busy}
              className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
            />
            <p className="text-[11px] text-zinc-600 mt-1.5">
              We&rsquo;ll email this address with the Stripe Checkout
              link to complete payment setup. Stays on the row as
              pending_buyer_email so you can resend if needed.
            </p>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5">
              Trial length
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {(['14', '7', '30', '0'] as const).map((days) => (
                <Button
                  key={days}
                  type="button"
                  variant={trialDays === days ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setTrialDays(days)}
                  disabled={busy}
                >
                  {days === '0' ? 'No trial' : `${days} days`}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-600 mt-1.5">
              Stripe attempts the first charge when the trial ends —
              if no card was captured, the subscription auto-fails
              past_due. Most operators give 14 days.
            </p>
          </div>

          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              background: 'rgba(255, 159, 58, 0.05)',
              borderColor: 'rgba(255, 159, 58, 0.3)',
              color: '#ffb86b',
            }}
          >
            The row flips to self-serve immediately on save, but
            Stripe billing only activates when the buyer completes
            Checkout. If they abandon, the row sits in &ldquo;awaiting
            payment setup&rdquo; — you can resend the link or convert
            back to agency-managed without re-running this flow.
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
              variant="primary"
              size="md"
              onClick={onConfirm}
              loading={busy}
              loadingLabel="Converting…"
              leftIcon={<Activity size={12} />}
            >
              Convert + send Checkout link
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
