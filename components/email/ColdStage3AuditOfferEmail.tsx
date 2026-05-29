/**
 * ColdStage3AuditOfferEmail — Stage 3 of the COLD-EMAIL reply-driven
 * funnel. Fires 30 min to 24 hr after a cold-cohort prospect engages
 * with their free TurfScan dashboard. This is the Anthony-as-founder
 * relational handoff: pitches a FREE Visibility Audit walkthrough call
 * (normally $497), positioned as a case-study exchange — a 30-min
 * audit-tour conversation about what we could do for their business.
 *
 * Sender: anthony@fourdots.io (alias on the anthony@fourdots.ca primary
 * Gmail account) via Gmail SMTP. This is the persona switch — Stage 2
 * came from the BDR mailbox in-thread; Stage 3 starts a NEW thread from
 * Anthony's actual email so:
 *   - Replies land directly in Anthony's Gmail inbox (no Unibox hop)
 *   - The "founder of Fourdots Digital" identity reads true (it IS
 *     Anthony writing now, from his real email)
 *   - "Sent" folder in Gmail shows what went out, useful for ops review
 *
 * Wired by: app/api/cron/cold-stage3/route.ts (Vercel Cron, every 15
 * min, gated by business hours: 10am-5pm Mon-Fri America/Toronto).
 */

import {
  Container,
  Link,
  Text,
} from '@react-email/components';
import { EmailLayout } from './EmailLayout';

export type ColdStage3AuditOfferEmailProps = {
  firstName: string;
  businessName: string;
  /** Operator-noun form ("roofer", "HVAC", "painter", "insulation
   *  contractor") — what phase2_push.derive_trade() produces.
   *  We derive the *vertical* form (roofing, HVAC, painting,
   *  insulation) internally for the "case studies in <vertical>" line. */
  trade: string;
  /** Currently unused in the body but kept for future copy variants
   *  and parity with the cron signature. */
  turfScoreBand?: string;
  topCompetitorName?: string | null;
  /** Anthony's Cal.com booking URL for the audit walkthrough. */
  calBookingUrl: string;
};

// Subject-line rotation — deterministic by prospect ID so a re-fire
// of the same prospect picks the same variant.
const SUBJECTS = [
  '{{first_name}}, your scan + a thought',
  'Saw you ran your TurfScan — quick offer',
  "What I'd do with your map data",
];

export function pickSubject(prospectId: string, firstName: string): string {
  let hash = 0;
  for (let i = 0; i < prospectId.length; i++) {
    hash = (hash * 31 + prospectId.charCodeAt(i)) & 0x7fffffff;
  }
  const template = SUBJECTS[hash % SUBJECTS.length];
  return template.replace('{{first_name}}', firstName);
}

/** Convert the operator-noun trade form (what phase2_push hands us)
 *  to the vertical-noun form that reads naturally in
 *  "case studies in <vertical>". Fallback to the input as-is so
 *  unknown trades don't break the sentence. */
function tradeToVertical(trade: string): string {
  const t = (trade || '').toLowerCase().trim();
  // Direct/known forms — handle plurals + operator nouns.
  if (t === 'roofer' || t === 'roofers' || t.includes('roof')) return 'roofing';
  if (t === 'hvac' || t.includes('heating') || t.includes('air conditioning') || t.includes('furnace')) return 'HVAC';
  if (t === 'painter' || t === 'painters' || t.includes('paint')) return 'painting';
  if (t.includes('insulation')) return 'insulation';
  if (t.includes('electric')) return 'electrical';
  if (t.includes('plumb')) return 'plumbing';
  if (t.includes('landscap')) return 'landscaping';
  if (t.includes('window')) return 'windows';
  if (t.includes('garage door')) return 'garage doors';
  if (t.includes('pool')) return 'pool services';
  if (t.includes('kitchen')) return 'kitchen renovation';
  if (t.includes('bathroom')) return 'bathroom renovation';
  if (t.includes('renovation') || t.includes('remodel')) return 'renovation';
  // Fallback — let it through as-is.
  return trade;
}

export default function ColdStage3AuditOfferEmail({
  firstName,
  businessName,
  trade,
  calBookingUrl,
}: ColdStage3AuditOfferEmailProps) {
  const tradeVertical = tradeToVertical(trade);

  const linkStyle: React.CSSProperties = {
    color: '#c5ff3a',
    textDecoration: 'underline',
    fontWeight: 600,
  };

  return (
    <EmailLayout
      preview={`${firstName}, your scan + a thought`}
    >
      <Container className="px-6 py-6">
        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          {firstName},
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          Saw you ran your scan for {businessName}. Quick intro —
          I&apos;m Anthony, founder of Fourdots Digital and the team
          behind TurfMap. Wanted to share something with you based on
          what came back.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          You&apos;ve already got the top 3 fixes in your dashboard.
          Most operators run those solo and see 10-20 points of
          TurfScore lift in 30 days. That&apos;s the free path
          forward.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          If you want a deeper look — full vertical-specific NAP
          audit, 90-Day Roadmap PDF, 30-day re-scan with a lift
          guarantee — I do a Visibility Audit. Normally $497.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          I&apos;m building case studies in {tradeVertical}{' '}
          right now, so for operators in this trade, I&apos;ll do the
          audit free in exchange for a 30-minute conversation about
          what we could do for your business afterward.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          If that&apos;s interesting, book a 30-min slot:{' '}
          <Link href={calBookingUrl} style={linkStyle}>
            {calBookingUrl}
          </Link>
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          The audit gets built out before the call. We walk through
          it together.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          — Anthony
          <br />
          Director, Fourdots Digital
        </Text>

        <Text className="text-zinc-400 text-sm leading-relaxed mt-6">
          P.S. If now isn&apos;t the right time, no pressure — the
          fix list in your dashboard has the top 3 actions you can
          run solo.
        </Text>
      </Container>
    </EmailLayout>
  );
}
