/**
 * Order confirmation — sent immediately after Stripe Checkout
 * lands the buyer on /order/success and the fulfill route creates
 * their client row + queues the first scan.
 *
 * Tier-aware: surfaces a tier badge + a "what happens next" line
 * that varies by what the buyer bought. Audit/Strategy variants
 * also include a Cal.com booking CTA when the URL is set on env.
 */

import { Section } from '@react-email/components';
import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
  TierBadge,
  COLORS,
} from './EmailLayout';

export type OrderConfirmationEmailProps = {
  businessName: string;
  tier: 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';
  dashboardUrl: string;
  /** Cal.com booking link for Audit + Strategy buyers. NULL when
   *  the env isn't set or the tier doesn't include a call. */
  bookingUrl?: string | null;
};

const TIER_LABEL: Record<OrderConfirmationEmailProps['tier'], string> = {
  scan: 'TurfScan',
  audit: 'Visibility Audit',
  strategy: 'Strategy Session',
  pulse: 'TurfMap Pulse',
  pulse_plus: 'TurfMap Pulse+',
};

const TIER_BLURB: Record<OrderConfirmationEmailProps['tier'], string> = {
  scan: 'a one-time 81-point geo-grid heatmap',
  audit: 'a 81-point geo-grid heatmap + citation audit + a 30-min strategist walkthrough',
  strategy: 'three keywords scanned + a written diagnosis + a 90-min strategist deep-dive',
  pulse: 'weekly geo-grid scans + score-movement alerts',
  pulse_plus: 'weekly geo-grid scans across 10 keywords + citation building + Slack delivery',
};

export function OrderConfirmationEmail({
  businessName,
  tier,
  dashboardUrl,
  bookingUrl,
}: OrderConfirmationEmailProps) {
  const tierLabel = TIER_LABEL[tier];
  const includesCall = tier === 'audit' || tier === 'strategy';
  const callLabel =
    tier === 'strategy' ? '90-minute strategy session' : '30-minute walkthrough';
  const isRecurring = tier === 'pulse' || tier === 'pulse_plus';

  return (
    <EmailLayout
      preview={`Your ${tierLabel} is on the way — ${businessName}`}
    >
      <H1>Your {tierLabel} is on the way.</H1>
      <P>
        We&rsquo;re scanning <strong>{businessName}</strong>&rsquo;s territory
        right now — {TIER_BLURB[tier]}. The first scan typically lands in
        30–60 seconds; we&rsquo;ll email when your TurfMap is ready.
      </P>

      {isRecurring && (
        <FactStrip
          items={[
            { label: 'Plan', value: tierLabel },
            { label: 'Status', value: 'Provisioning' },
          ]}
        />
      )}

      <PrimaryButton href={dashboardUrl}>
        Open my TurfMap →
      </PrimaryButton>

      {includesCall && bookingUrl && (
        <Section
          style={{
            marginTop: 24,
            padding: 16,
            backgroundColor: COLORS.BG,
            border: `1px solid ${COLORS.BORDER}`,
            borderRadius: 6,
          }}
        >
          <P>
            <strong>Book your {callLabel}</strong>
            <br />
            Pick a time that works — we&rsquo;ve pre-filled your details
            so it&rsquo;s one click.
          </P>
          <PrimaryButton href={bookingUrl}>Book my call →</PrimaryButton>
        </Section>
      )}

      {includesCall && !bookingUrl && (
        <PSmall>
          Your strategist will email separately within 2 business days
          to schedule your {callLabel}.
        </PSmall>
      )}

      {tier === 'pulse_plus' && (
        <PSmall>
          Pulse+ unlocks <TierBadge tier="pulse_plus" /> — citation
          building queues up after the first scan; we&rsquo;ll send a
          short onboarding form to capture the categories and hours
          we need to submit your listings.
        </PSmall>
      )}

      <PSmall>
        Questions? Just hit reply — this address is monitored.
      </PSmall>
    </EmailLayout>
  );
}
