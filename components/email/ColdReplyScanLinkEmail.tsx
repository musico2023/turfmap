/**
 * ColdReplyScanLinkEmail — Stage 2 of the COLD-EMAIL reply-driven
 * funnel. Sent in response to a positive reply ("yes", "send it",
 * "sure", etc.) on the cold-email sequence. Delivers the prospect's
 * personalized free-TurfScan URL with the COLDSCAN coupon pre-applied.
 *
 * Send path: IN-THREAD reply via Instantly's POST /api/v2/emails/reply.
 * The email ships from the SAME mailbox (eaccount) that sent the
 * original cold message — preserving thread continuity and the BDR
 * persona on that mailbox (philip@breakthroughactivate.com,
 * howard@..., stephanie@..., etc.). The prospect's mail client
 * groups it under the existing conversation.
 *
 * Persona note: NO signature block in this email. The mailboxes
 * rotate across personas; injecting an "Anthony" sig here would
 * break that persona's voice. The Stage 3 audit-offer email is
 * where the relational handoff happens (Anthony, founder of
 * Fourdots Digital + TurfMap.ai) — Stage 3 is sent from
 * hi@turfmap.ai as a NEW thread, intentionally.
 *
 * Trigger:
 *   - Auto (default): /api/cron/instantly-poll-replies polls Instantly
 *     every 2 min, classifies positive replies via Claude Haiku, then
 *     schedules this email for NOW + 11 min by writing
 *     stage_2_scheduled_at on the prospect row. The same cron's
 *     second pass picks up due rows and posts to Instantly's reply API.
 *   - Manual fallback: Anthony POSTs to /api/admin/send-cold-stage2
 *     with the prospect_id (operator path, useful for ambiguous
 *     replies the classifier routes to him).
 */

import {
  Container,
  Link,
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

export const COLD_STAGE2_SUBJECT =
  "Here's your TurfScan — {{business_name}}";

export default function ColdReplyScanLinkEmail({
  firstName,
  businessName,
  trade,
  scanUrl,
}: ColdReplyScanLinkEmailProps) {
  // Shared inline-link style — matches the lime accent used everywhere
  // else (CTA buttons in other emails, lander hero accents).
  const linkStyle: React.CSSProperties = {
    color: '#c5ff3a',
    textDecoration: 'underline',
    fontWeight: 600,
  };

  return (
    <EmailLayout
      preview={`${firstName}, your TurfScan link for ${businessName}`}
    >
      <Container className="px-6 py-6">
        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          {firstName},
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          Np, here&apos;s{' '}
          <Link href={scanUrl} style={linkStyle}>
            the link
          </Link>
          .
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          It&apos;s a 9×9 grid across your service area showing where
          you appear in Google&apos;s map pack for {trade} searches,
          and which competitors are taking the cells you&apos;re
          missing.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          Will take less than a minute to run, free only with that
          link. Once you run your scan click the AI coach section at
          the bottom to generate the fix list — 3 priority actions to
          make fast improvement on your score.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          Reply if anything looks off, let me know if it&apos;s of
          use.
        </Text>
        {/*
          No signature block — this email sends in-thread from one of
          the rotating cold-email mailbox personas (philip@..., howard@...,
          stephanie@..., etc.). The mailbox's existing sender persona is
          preserved; injecting an "Anthony" sig here would break the
          persona continuity. The Stage 3 audit-offer email switches to
          Anthony's founder voice — that's where the persona handoff
          happens, not here.
        */}
      </Container>
    </EmailLayout>
  );
}
