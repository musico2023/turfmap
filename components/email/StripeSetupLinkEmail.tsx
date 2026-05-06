/**
 * Stripe Checkout setup link — sent when the agency operator
 * creates a client via the agency-side plan selector with a Pulse
 * or Pulse+ plan. Carries the Checkout URL the buyer clicks to
 * start their trial / subscription.
 *
 * Tier badge + trial summary FactStrip up top so the buyer sees
 * exactly what they're signing up for before clicking through.
 */

import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
  TierBadge,
} from './EmailLayout';

export type StripeSetupLinkEmailProps = {
  businessName: string;
  tier: 'pulse' | 'pulse_plus';
  trialDays: number;
  checkoutUrl: string;
};

export function StripeSetupLinkEmail({
  businessName,
  tier,
  trialDays,
  checkoutUrl,
}: StripeSetupLinkEmailProps) {
  const tierLabel = tier === 'pulse_plus' ? 'TurfMap Pulse+' : 'TurfMap Pulse';
  const monthlyPrice = tier === 'pulse_plus' ? '$99/mo' : '$39/mo';
  const hasTrial = trialDays > 0;

  return (
    <EmailLayout
      preview={`Set up your ${tierLabel} account — ${businessName}`}
    >
      <P>
        <TierBadge tier={tier} />
      </P>
      <H1>Set up your {tierLabel} account.</H1>
      <P>
        Your account for <strong>{businessName}</strong> is provisioned
        and ready. Click the button below to complete payment setup
        with Stripe — same checkout you&rsquo;d see on any modern
        subscription product.
      </P>

      <FactStrip
        items={
          hasTrial
            ? [
                { label: 'Plan', value: tierLabel.replace('TurfMap ', '') },
                { label: 'Trial', value: `${trialDays} days free` },
                { label: 'After trial', value: monthlyPrice },
              ]
            : [
                { label: 'Plan', value: tierLabel.replace('TurfMap ', '') },
                { label: 'Billing', value: monthlyPrice },
              ]
        }
      />

      <PrimaryButton href={checkoutUrl}>
        Complete payment setup →
      </PrimaryButton>

      <PSmall>
        {hasTrial
          ? `Your ${trialDays}-day trial starts as soon as you complete checkout. We don't charge anything until day ${trialDays + 1} — cancel any time before then with no fees.`
          : 'Checkout starts your subscription immediately. You can cancel any time from your dashboard.'}
      </PSmall>

      <PSmall>
        The link expires in 24 hours — if it stops working, hit reply
        and we&rsquo;ll send a fresh one.
      </PSmall>
    </EmailLayout>
  );
}
