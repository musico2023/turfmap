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
  /**
   * Pre-formatted scheduled-call timestamp (e.g. "Tuesday, Aug 12
   * at 2:00 pm EST"). Set on Audit upgrades from the dashboard
   * where the strategist call is auto-scheduled at upgrade time;
   * leave null on standalone Audit purchases where the buyer
   * still needs to pick a slot via Cal.com.
   *
   * When non-null, the email's scheduling line reads "Your
   * strategist call is scheduled for {scheduledAt}." instead of
   * the auto-schedule promise.
   */
  scheduledAt?: string | null;
  /**
   * Frames the audit-tier headline as either a fresh purchase
   * ("standalone") or a TurfScan→Audit upgrade ("upgrade"). Only
   * affects audit; ignored for other tiers. Defaults to
   * 'standalone' so direct Stripe-Checkout audit buyers get the
   * intended copy without the caller having to pass anything new.
   */
  auditPurchaseKind?: 'standalone' | 'upgrade';
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
  // Audit blurb intentionally tighter post-roadmap-rev — the
  // dedicated AuditDeliverables block below carries the full list.
  audit: 'an 81-point geo-grid scan + your 90-day Visibility Roadmap, built by a TurfMap strategist',
  strategy: 'three keywords scanned + a written diagnosis + a 90-min strategist deep-dive',
  pulse: 'weekly geo-grid scans + score-movement alerts',
  pulse_plus: 'weekly geo-grid scans across 10 keywords + citation building + Slack delivery',
};

/**
 * Canonical Visibility Audit deliverables — kept in sync with the
 * homepage PricingCards bullets. Single source of truth for the
 * "what you actually get" framing across the audit confirmation
 * email and any future surfaces (status page, dashboard upsell,
 * cold-outreach emails, etc.).
 */
const AUDIT_DELIVERABLES: readonly string[] = [
  '30-minute strategist diagnostic call (live competitor teardown + score interpretation)',
  'Per-vertical NAP audit — every directory specific to your trade',
  'Competitor analysis with heatmap overlay (your nearest 3 competitors)',
  '90-Day Visibility Roadmap (PDF) — week-by-week action plan with projected TurfScore lift per action',
  '30-day automated re-scan to measure progress',
  '60-day strategist check-in call to review re-scan and adjust the plan',
  'TurfScore Lift Promise: minimum 10-point lift in 30 days, or we redo the analysis at no charge',
];

export function OrderConfirmationEmail({
  businessName,
  tier,
  dashboardUrl,
  bookingUrl,
  scheduledAt,
  auditPurchaseKind = 'standalone',
}: OrderConfirmationEmailProps) {
  const tierLabel = TIER_LABEL[tier];
  const includesCall = tier === 'audit' || tier === 'strategy';
  const callLabel =
    tier === 'strategy' ? '90-minute strategy session' : '30-minute strategist diagnostic call';
  const isRecurring = tier === 'pulse' || tier === 'pulse_plus';
  const isAudit = tier === 'audit';
  const isAuditUpgrade = isAudit && auditPurchaseKind === 'upgrade';

  // Audit-specific headline tone. Standalone framing matches the
  // generic "is on the way" template; upgrade framing acknowledges
  // the prior TurfScan purchase + the credit applied. Both keep
  // the same deliverables block + scheduling line below.
  const auditHeadline = isAuditUpgrade
    ? 'You upgraded to Visibility Audit.'
    : 'Your TurfMap Visibility Audit — what happens next.';

  return (
    <EmailLayout
      preview={
        isAudit
          ? `Your TurfMap Visibility Audit — what happens next`
          : `Your ${tierLabel} is on the way — ${businessName}`
      }
    >
      <H1>{isAudit ? auditHeadline : `Your ${tierLabel} is on the way.`}</H1>

      {!isAudit && (
        <P>
          We&rsquo;re scanning <strong>{businessName}</strong>&rsquo;s territory
          right now — {TIER_BLURB[tier]}. The first scan typically lands in
          30–60 seconds; we&rsquo;ll email when your TurfMap is ready.
        </P>
      )}

      {isAudit && (
        <P>
          {isAuditUpgrade ? (
            <>
              Thanks for upgrading <strong>{businessName}</strong>&rsquo;s
              account. Here&rsquo;s what comes next.
            </>
          ) : (
            <>
              Thanks for ordering the Visibility Audit for{' '}
              <strong>{businessName}</strong>. Here&rsquo;s what comes
              next.
            </>
          )}
        </P>
      )}

      {/* AUDIT DELIVERABLES — full canonical list, sourced from
       *  AUDIT_DELIVERABLES so the email matches the homepage
       *  pricing card verbatim. Renders only for tier=audit. */}
      {isAudit && (
        <Section
          style={{
            marginTop: 12,
            marginBottom: 24,
            padding: 16,
            backgroundColor: COLORS.CARD,
            border: `1px solid ${COLORS.BORDER}`,
            borderRadius: 6,
          }}
        >
          <P>
            <strong>What&rsquo;s included in your Visibility Audit:</strong>
          </P>
          <ul
            style={{
              paddingLeft: 18,
              margin: '8px 0 0 0',
              color: COLORS.TEXT_MUTED,
              fontSize: 14,
              lineHeight: '1.6',
            }}
          >
            {AUDIT_DELIVERABLES.map((item) => (
              <li key={item} style={{ marginBottom: 6 }}>
                {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {isRecurring && (
        <FactStrip
          items={[
            { label: 'Plan', value: tierLabel },
            { label: 'Status', value: 'Provisioning' },
          ]}
        />
      )}

      {/* Scheduling block — different copy for audit vs. strategy
       *  because the audit's auto-schedule mechanic is different
       *  from strategy's hand-scheduled flow. Audit copy diverges
       *  further on whether the call is already scheduled (upgrade
       *  flow with scheduledAt set) or not (standalone flow). */}
      {isAudit && scheduledAt ? (
        <Section
          style={{
            marginTop: 12,
            padding: 16,
            backgroundColor: COLORS.BG,
            border: `1px solid ${COLORS.BORDER}`,
            borderRadius: 6,
          }}
        >
          <P>
            <strong>Your strategist call is scheduled for {scheduledAt}.</strong>
            <br />
            We&rsquo;ll send a calendar invite shortly. The 90-Day
            Roadmap PDF lands in your inbox within 24 hours of the
            call.
          </P>
        </Section>
      ) : isAudit ? (
        <Section
          style={{
            marginTop: 12,
            padding: 16,
            backgroundColor: COLORS.BG,
            border: `1px solid ${COLORS.BORDER}`,
            borderRadius: 6,
          }}
        >
          <P>
            <strong>Your strategist diagnostic call:</strong>
            <br />
            We auto-schedule within 1 business day — you&rsquo;ll get
            a calendar invite to confirm. The 90-Day Roadmap PDF
            lands in your inbox within 24 hours of the call.
          </P>
          {bookingUrl && (
            <PrimaryButton href={bookingUrl}>
              Pick your time now →
            </PrimaryButton>
          )}
        </Section>
      ) : null}

      <PrimaryButton href={dashboardUrl}>
        Open my TurfMap →
      </PrimaryButton>

      {/* Strategy tier keeps its prior booking block — the audit's
       *  re-templated scheduling section above replaces this for
       *  audit only. */}
      {tier === 'strategy' && bookingUrl && (
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

      {tier === 'strategy' && !bookingUrl && (
        <PSmall>
          Your strategist will email separately within 2 business days
          to schedule your {callLabel}.
        </PSmall>
      )}

      {/* TurfScore Lift Promise context — only on audit. Concrete
       *  framing of the guarantee so the buyer understands the
       *  measurable claim before they sit on the call. */}
      {isAudit && (
        <PSmall>
          <strong>TurfScore Lift Promise.</strong> Your roadmap is built
          to deliver a minimum 10-point TurfScore lift in 30 days. If
          your re-scan doesn&rsquo;t show that lift after you&rsquo;ve
          executed the plan, we&rsquo;ll redo the analysis at no charge.
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
