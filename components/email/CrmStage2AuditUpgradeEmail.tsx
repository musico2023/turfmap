/**
 * CrmStage2AuditUpgradeEmail — Stage 2 of the CRM warm-reactivation
 * funnel. Fires 30 min to 24 hr after a VIP-coupon cohort prospect
 * engages with their free TurfScan dashboard. Pitches the $197
 * Visibility Audit upgrade (normally $499) with a 24-hour window.
 *
 * Personal-voice + lower-case "I" — Anthony's signature on outbound
 * to warm prospects. Subject line variants are rotated by the cron
 * so a recipient who's getting cc'd on multiple prospect threads
 * (sometimes happens with agencies) doesn't see identical messages.
 *
 * Wired by: app/api/cron/crmvip-stage2/route.ts (Vercel Cron, every
 * 15 minutes). The cron polls prospects for trigger conditions and
 * sends one email per qualifying prospect via Resend.
 */

import {
  Button,
  Container,
  Hr,
  Section,
  Text,
} from '@react-email/components';
import { EmailLayout } from './EmailLayout';

export type CrmStage2AuditUpgradeEmailProps = {
  firstName: string;
  businessName: string;
  turfScoreBand: string;
  topCompetitorName: string | null;
  auditUpgradeUrl: string;
};

export default function CrmStage2AuditUpgradeEmail({
  firstName,
  businessName,
  turfScoreBand,
  topCompetitorName,
  auditUpgradeUrl,
}: CrmStage2AuditUpgradeEmailProps) {
  // Fallback if competitor data is missing — keeps the email
  // sendable for prospects whose grid scan returned no
  // identifiable competitors.
  const competitorClause = topCompetitorName
    ? `a ${turfScoreBand} score with ${topCompetitorName} dominating most of your service area`
    : `a ${turfScoreBand} score across most of your service area`;

  return (
    <EmailLayout
      preview={`${firstName}, your TurfScan results + a next step`}
    >
      <Container className="px-6 py-6">
        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          {firstName},
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          I saw you ran your TurfScan. The picture is what I expected
          — {competitorClause}.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          The Fix List in your dashboard shows you the top 3 actions.
          Most operators execute those solo and see 10&ndash;20 points
          of TurfScore lift in 30 days.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          If you&rsquo;d rather have a strategist walk through the
          findings with you and build a 90-day Roadmap specifically
          for {businessName}, I can offer you the Visibility Audit at{' '}
          <strong style={{ color: '#f4f4f5' }}>$197</strong> (normally
          $499 &mdash; buyer-only pricing for the next 24 hours).
        </Text>

        <Hr style={{ borderColor: '#1f1f1f', margin: '24px 0' }} />

        <Text
          className="text-[10px] uppercase font-mono mb-3"
          style={{ color: '#a3a3a3', letterSpacing: '0.18em' }}
        >
          What&rsquo;s included
        </Text>

        <Text className="text-zinc-300 text-sm leading-relaxed mb-1">
          &#10003; 30-min strategist diagnostic call (me, walking through
          your map)
        </Text>
        <Text className="text-zinc-300 text-sm leading-relaxed mb-1">
          &#10003; Per-vertical NAP audit specific to your trade
        </Text>
        <Text className="text-zinc-300 text-sm leading-relaxed mb-1">
          &#10003; 90-Day Visibility Roadmap PDF
        </Text>
        <Text className="text-zinc-300 text-sm leading-relaxed mb-1">
          &#10003; 30-day re-scan + 60-day check-in call
        </Text>
        <Text className="text-zinc-300 text-sm leading-relaxed mb-4">
          &#10003; <strong>TurfScore Lift Promise:</strong>{' '}
          implement within 14 days. +10 TurfScore points in 90 days, or your
          $499 back.
        </Text>

        <Section className="text-center my-6">
          <Button
            href={auditUpgradeUrl}
            style={{
              background: '#c5ff3a',
              color: '#000',
              padding: '14px 28px',
              borderRadius: '8px',
              fontWeight: 700,
              fontSize: '14px',
              textDecoration: 'none',
            }}
          >
            Upgrade to Visibility Audit &rarr;
          </Button>
        </Section>

        <Text className="text-zinc-400 text-sm leading-relaxed mb-4">
          Or if you&rsquo;d rather just execute the Fix List and chat
          in 60 days about where you&rsquo;ve landed &mdash; no
          problem at all.
        </Text>

        <Hr style={{ borderColor: '#1f1f1f', margin: '24px 0' }} />

        <Text className="text-zinc-300 text-sm leading-relaxed mb-1">
          &mdash; Anthony
        </Text>
        <Text className="text-zinc-500 text-xs leading-relaxed">
          Fourdots Digital
        </Text>
      </Container>
    </EmailLayout>
  );
}

// Subject line variants — cron rotates by a stable hash of the
// prospect id so re-sends to the same buyer (which shouldn't happen
// per stage_2_sent_at idempotency, but defense-in-depth) land the
// same subject.
export const SUBJECT_VARIANTS = [
  'Your TurfScan results + next step',
  'I saw you ran your TurfScan — quick thought',
  "What I'd do next based on your TurfMap",
];

export function pickSubject(prospectId: string): string {
  let h = 0;
  for (const ch of prospectId) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }
  const idx = Math.abs(h) % SUBJECT_VARIANTS.length;
  return SUBJECT_VARIANTS[idx];
}
