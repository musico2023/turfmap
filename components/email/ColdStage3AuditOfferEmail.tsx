/**
 * ColdStage3AuditOfferEmail — Stage 3 of the COLD-EMAIL reply-driven
 * funnel. Fires 30 min to 24 hr after a cold-cohort prospect engages
 * with their free TurfScan dashboard. Pitches a FREE Visibility Audit
 * call (no Stripe checkout) — the prospect books a slot on Anthony's
 * Cal.com link, which then triggers the existing audit fulfillment
 * pipeline (auto-Roadmap PDF, Strategist Prep Notes, etc.) for the
 * Anthony-side prep.
 *
 * Personal-voice + lower-case "I" — same Anthony signature as the
 * VIP Stage 2 email. The cold-cohort version is intentionally
 * structurally similar to the VIP Stage 2 (same metric-led opener,
 * same one-CTA discipline) so buyers feel a consistent operator
 * voice even though the offer differs.
 *
 * COPY STATUS: PLACEHOLDER. Replace the body text below with the
 * final Stage 3 copy from the marketing brief before going live.
 * The subject-line rotation list (`SUBJECTS`) is also placeholder
 * and should be replaced with the variants from the brief.
 *
 * Wired by: app/api/cron/cold-stage3/route.ts (Vercel Cron, every
 * 15 minutes).
 */

import {
  Button,
  Container,
  Hr,
  Section,
  Text,
} from '@react-email/components';
import { EmailLayout } from './EmailLayout';

export type ColdStage3AuditOfferEmailProps = {
  firstName: string;
  businessName: string;
  turfScoreBand: string;
  topCompetitorName: string | null;
  /** Anthony's Cal.com booking URL. Wired from the cron's
   *  COLD_STAGE3_CAL_URL env (defaults to the production link). */
  calBookingUrl: string;
};

// PLACEHOLDER subject lines. Replace with brief copy when it lands.
// The cron uses `pickSubject(prospectId)` to deterministically rotate
// through these so a re-fired email picks the same variant.
const SUBJECTS = [
  "Quick next step on {{business_name}}'s TurfScan",
  "Free walkthrough — your scan + the fixes",
  "Want me to walk through {{business_name}}'s scan?",
];

export function pickSubject(prospectId: string): string {
  // Deterministic hash of the prospect ID modulo subject count.
  // Same prospect always gets the same subject if the cron re-fires
  // (idempotent across retries).
  let hash = 0;
  for (let i = 0; i < prospectId.length; i++) {
    hash = (hash * 31 + prospectId.charCodeAt(i)) & 0x7fffffff;
  }
  return SUBJECTS[hash % SUBJECTS.length];
}

export default function ColdStage3AuditOfferEmail({
  firstName,
  businessName,
  turfScoreBand,
  topCompetitorName,
  calBookingUrl,
}: ColdStage3AuditOfferEmailProps) {
  // Fallback if competitor data is missing.
  const competitorClause = topCompetitorName
    ? `a ${turfScoreBand} score with ${topCompetitorName} taking most of your service area`
    : `a ${turfScoreBand} score across most of your service area`;

  return (
    <EmailLayout
      preview={`${firstName}, want me to walk through ${businessName}'s scan?`}
    >
      <Container className="px-6 py-6">
        {/*
          PLACEHOLDER COPY — replace the body with the final Stage 3 text
          from the marketing brief. The merge fields below should match
          the brief's spec: {{first_name}}, {{business_name}},
          {{turf_score_band}}, {{top_competitor_name}}, plus the
          calendar CTA URL.
        */}
        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          {firstName},
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          [PLACEHOLDER — Stage 3 opener] I saw you ran the scan for
          {' '}{businessName}. The picture is what I expected —
          {' '}{competitorClause}.
        </Text>

        <Text className="text-zinc-200 text-base leading-relaxed mb-4">
          [PLACEHOLDER — pitch the free Visibility Audit walkthrough]
          I&apos;d like to walk you through the full audit on a quick
          call. No charge, no pitch deck — just the three highest-
          impact fixes for your specific cells and the roadmap to
          get out of the {turfScoreBand} band.
        </Text>

        <Section className="text-center my-6">
          <Button
            href={calBookingUrl}
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
            Book the walkthrough
          </Button>
        </Section>

        <Text className="text-zinc-400 text-sm leading-relaxed mb-2">
          [PLACEHOLDER — close] If now isn&apos;t the right week, just
          hit reply and we&apos;ll find a better time.
        </Text>

        <Hr style={{ borderColor: '#27272a', margin: '24px 0' }} />

        <Text className="text-zinc-500 text-xs leading-relaxed">
          Anthony, TurfMap.ai · Four Dots Digital
        </Text>
      </Container>
    </EmailLayout>
  );
}
