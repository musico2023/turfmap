'use client';

import { Clock } from 'lucide-react';

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
 * Server-side rendering so we can't expose a "regenerate Checkout
 * link" button without a corresponding endpoint. For now operator
 * resends the original link by hand from email/Slack; if the link
 * is genuinely lost or expired, recreate the client row.
 */
export type AwaitingPaymentSetupCardProps = {
  /** Tier the client was created with — drives the "Pulse" / "Pulse+"
   *  copy in the body. */
  tier: 'pulse' | 'pulse_plus' | null;
};

export function AwaitingPaymentSetupCard({
  tier,
}: AwaitingPaymentSetupCardProps) {
  const planLabel =
    tier === 'pulse_plus'
      ? 'Pulse+'
      : tier === 'pulse'
        ? 'Pulse'
        : 'recurring';
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
        <div>
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
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            If they lost the link or it expired (24h Stripe default),
            recreate the client to generate a fresh one.
          </p>
        </div>
      </div>
    </div>
  );
}
