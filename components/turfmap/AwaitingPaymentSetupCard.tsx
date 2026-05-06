'use client';

import { useState } from 'react';
import { Clock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Settings-page card that surfaces when a client was created via
 * the agency-side plan selector with a Stripe plan, but the buyer
 * hasn't yet completed Checkout.
 *
 * Visible state: billing_mode='self_serve_subscription' AND
 * stripe_subscription_id IS NULL. Once the buyer finishes Checkout,
 * the webhook (customer.subscription.created) writes the
 * subscription id and this card vanishes — replaced by the regular
 * SubscriptionPanel.
 *
 * Regenerate flow: the original Checkout link expires 24h after
 * creation (Stripe default). Click "Resend / regenerate link" to
 * fire /api/clients/[id]/regenerate-checkout — we re-send the
 * setup email to the buyer's pending email, and surface the new
 * URL inline for copy-to-clipboard backup.
 */
export type AwaitingPaymentSetupCardProps = {
  /** Client UUID — used by the regenerate endpoint. */
  clientId: string;
  /** Tier the client was created with — drives the "Pulse" / "Pulse+"
   *  copy in the body. */
  tier: 'pulse' | 'pulse_plus' | null;
  /** Buyer email captured at create time. Used to display "we'll
   *  email <addr>" before the operator clicks regenerate. */
  pendingBuyerEmail: string | null;
};

export function AwaitingPaymentSetupCard({
  clientId,
  tier,
  pendingBuyerEmail,
}: AwaitingPaymentSetupCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const planLabel =
    tier === 'pulse_plus'
      ? 'Pulse+'
      : tier === 'pulse'
        ? 'Pulse'
        : 'recurring';

  const onRegenerate = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/regenerate-checkout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const data = (await res.json()) as {
        ok?: boolean;
        checkout_url?: string;
        setup_email_sent?: boolean;
        error?: string;
      };
      if (!res.ok || !data.checkout_url) {
        setError(data.error ?? `regenerate failed (HTTP ${res.status})`);
        return;
      }
      setCheckoutUrl(data.checkout_url);
      setEmailSent(Boolean(data.setup_email_sent));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    if (!checkoutUrl) return;
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // Clipboard fail (non-https). Operator can still select+copy
      // the URL from the rendered text.
    }
  };

  return (
    <div
      className="rounded-lg border p-5"
      style={{
        background: 'rgba(255, 159, 58, 0.04)',
        borderColor: 'rgba(255, 159, 58, 0.3)',
      }}
    >
      <div className="flex items-start gap-3">
        <Clock
          size={16}
          className="flex-shrink-0 mt-0.5"
          style={{ color: '#ffb86b' }}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-base font-bold text-zinc-100">
            Awaiting buyer payment setup
          </h3>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            This client was created on the {planLabel} plan but
            hasn&rsquo;t yet completed Stripe Checkout. The trial /
            subscription will activate as soon as they finish — the
            webhook updates this row automatically; no further action
            on your end if the buyer has the Checkout link.
          </p>
          {pendingBuyerEmail && (
            <p className="text-[11px] text-zinc-500 mt-2 font-mono flex items-center gap-1.5">
              <Mail size={11} />
              Buyer email:{' '}
              <span className="text-zinc-300">{pendingBuyerEmail}</span>
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRegenerate}
              loading={busy}
              loadingLabel="Regenerating…"
              disabled={busy}
            >
              Resend / regenerate link
            </Button>
            {error && (
              <span className="text-xs text-red-400 font-mono">
                {error}
              </span>
            )}
          </div>

          {checkoutUrl && (
            <div className="mt-4 space-y-2">
              <div
                className="rounded-md border px-3 py-2 font-mono text-[11px] break-all"
                style={{
                  background: 'var(--color-bg)',
                  borderColor: 'var(--color-border)',
                  color: '#e4e4e7',
                }}
              >
                {checkoutUrl}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onCopy}
                >
                  {linkCopied ? '✓ Copied' : 'Copy link'}
                </Button>
                <span>
                  {emailSent
                    ? 'Email re-sent to the buyer.'
                    : 'Email delivery failed — forward this link manually.'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
