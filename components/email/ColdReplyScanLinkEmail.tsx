/**
 * ColdReplyScanLinkEmail — Stage 2 of the COLD-EMAIL reply-driven
 * funnel. Sent in response to a positive reply ("yes", "send it",
 * "sure", etc.) on the cold-email sequence. Delivers the prospect's
 * personalized free-TurfScan URL with the COLDSCAN coupon pre-applied.
 *
 * Trigger:
 *   - Manual (Option B, current default): Anthony reviews the Instantly
 *     Unibox for replies and POSTs to /api/admin/send-cold-stage2 with
 *     the prospect_id once he's verified positive intent.
 *   - Auto (Option C, future): an NLP classifier on Instantly's reply
 *     stream auto-triggers for high-confidence positives; ambiguous
 *     ones still surface to Anthony.
 *
 * COPY STATUS: PLACEHOLDER. Replace the body text below with the
 * final Stage 2 reply-response copy from the marketing brief before
 * going live.
 */

import {
  Button,
  Container,
  Hr,
  Section,
  Text,
} from '@react-email/components';
import { EmailLayout } from './EmailLayout';

export type ColdReplyScanLinkEmailProps = {
  firstName: string;
  businessName: string;
  trade: string;
  /** Full personalized scan URL with prospect_id + COLDSCAN coupon
   *  + UTM params already encoded. The /api endpoint builds this. */
  scanUrl: string;
};

// PLACEHOLDER subject. Replace with brief copy when it lands.
export const COLD_STAGE2_SUBJECT =
  "Here's your TurfScan — {{business_name}}";

export default function ColdReplyScanLinkEmail({
  firstName,
  businessName,
  trade,
  scanUrl,
}: ColdReplyScanLinkEmailProps) {
  return (
    <EmailLayout
      preview={`${firstName}, your TurfScan link for ${businessName}`}
    >
      <Container className="px-6 py-6">
        {/*
          PLACEHOLDER COPY — replace with final Stage 2 reply-response
          text from the marketing brief.
        */}
        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          {firstName},
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          [PLACEHOLDER — thank for reply, deliver link] Here&apos;s the
          scan I mentioned for {businessName}. It&apos;s a 9×9 grid
          across your service area showing where you appear in
          Google&apos;s map pack for {trade} searches, and which
          competitors are taking the cells you&apos;re missing.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          [PLACEHOLDER — set expectation: ~1 min to run, free with
          this link, view your dashboard, reply if anything looks
          off]
        </Text>

        <Section className="text-center my-6">
          <Button
            href={scanUrl}
            className="inline-block bg-lime-400 text-zinc-950 px-6 py-3 rounded-md font-semibold text-sm"
            style={{
              backgroundColor: '#c5ff3a',
              color: '#0a0a0a',
              padding: '14px 24px',
              borderRadius: 6,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Run your free TurfScan
          </Button>
        </Section>

        <Text className="text-zinc-400 text-sm leading-relaxed mb-2">
          Link is keyed to {businessName} — coupon is pre-applied so
          it&apos;s a $0 checkout (no card needed).
        </Text>

        <Hr style={{ borderColor: '#27272a', margin: '24px 0' }} />

        <Text className="text-zinc-500 text-xs leading-relaxed">
          Anthony, TurfMap.ai · Four Dots Digital
        </Text>
      </Container>
    </EmailLayout>
  );
}
