/**
 * Visibility Audit Roadmap ready — sent to the buyer ~30-60s after
 * audit-tier purchase, with the AI-generated 90-Day Roadmap PDF
 * attached.
 *
 * Surfaces the buyer's starting TurfScore + projected lift inline so
 * they can read the headline result without opening the PDF. The
 * deliverable that lives in their inbox is the PDF itself — this
 * email is the "your deliverable just landed" wrapper.
 *
 * Sent alongside (NOT instead of) the standard scan-ready email —
 * scan-ready arrives the moment the scan completes; this email
 * arrives ~30-60s later once Claude finishes generating the Roadmap.
 * The two-email pattern keeps the scan-ready timing snappy (the
 * buyer sees their map immediately) and lets the Roadmap arrive
 * when it's actually ready.
 */

import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditRoadmapReadyEmailProps = {
  businessName: string;
  /** Buyer's TurfScore on the just-completed scan. */
  startingTurfScore: number;
  /** Starting + 30-day target lift. Projected, not promised — the
   *  Lift Promise itself is a flat 10-point floor written into the
   *  PDF. */
  projectedTurfScore: number;
  /** Anthropic-generated diagnosis blurb (1-2 sentences). Used as
   *  the inline preview text below the score-strip. Keep short —
   *  long diagnosis lives in the PDF; the email is the trailer. */
  diagnosisPreview: string;
  /** Buyer's TurfMap dashboard URL — surfaces the heatmap + AI
   *  Coach Fix List as a companion to the PDF. */
  dashboardUrl: string;
};

export function AuditRoadmapReadyEmail({
  businessName,
  startingTurfScore,
  projectedTurfScore,
  diagnosisPreview,
  dashboardUrl,
}: AuditRoadmapReadyEmailProps) {
  const lift = Math.max(0, projectedTurfScore - startingTurfScore);
  return (
    <EmailLayout
      preview={`Your 90-Day Visibility Roadmap is ready — ${businessName}`}
    >
      <H1>Your 90-Day Visibility Roadmap is ready.</H1>
      <P>
        Attached is your full 90-day plan for <strong>{businessName}</strong>:
        a 12-week, week-by-week action sequence across the three Local
        Lead Machine pillars — <strong>Demand</strong>,{' '}
        <strong>Visibility</strong>, and <strong>Systems</strong> —
        each item tagged with its projected TurfScore lift, difficulty,
        and whether it&apos;s done-for-you under LLM.
      </P>

      <FactStrip
        items={[
          { label: 'Starting TurfScore', value: `${startingTurfScore} / 100` },
          {
            label: '30-day target',
            value: `${projectedTurfScore} / 100`,
          },
          { label: 'Projected lift', value: `+${lift} pts` },
        ]}
      />

      <P>
        <strong>Diagnosis:</strong> {diagnosisPreview}
      </P>

      <PrimaryButton href={dashboardUrl}>Open my TurfMap →</PrimaryButton>

      <PSmall>
        Your PDF Roadmap is attached. The dashboard above complements
        the PDF with your live heatmap + AI Coach Fix List for the
        first three moves to execute.
      </PSmall>
    </EmailLayout>
  );
}
