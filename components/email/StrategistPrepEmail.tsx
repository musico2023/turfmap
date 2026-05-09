/**
 * Strategist Prep Notes email — operator-facing, sent to
 * anthony@fourdots.io 24 hours before each scheduled Visibility Audit
 * strategist call. Carries:
 *
 *   - The buyer-facing Roadmap PDF (signed Storage URL)
 *   - The internal Strategist Prep Notes markdown (signed Storage URL)
 *   - Inline summary: TurfScore, LLM Fit Score, biggest finding
 *   - Quick links: buyer dashboard, audit row in agency dashboard
 *
 * The buyer never sees this. The Roadmap PDF is also delivered to
 * the buyer post-call via a Superhuman snippet — the two touches
 * are decoupled by design.
 */

import { EmailLayout, FactStrip, H1, P, PSmall, PrimaryButton, SecondaryButton } from './EmailLayout';

export type StrategistPrepEmailProps = {
  /** Buyer business + scheduled call time string. */
  businessName: string;
  trade: string;
  market: string;
  /** Pre-formatted human-readable call time. */
  scheduledCallTime: string;
  /** Score family at audit purchase. */
  currentTurfScore: number;
  projectedTurfScore: number;
  /** 1-5 LLM Fit Score. Surfaces in the subject + the at-a-glance
   *  fact strip so Anthony knows whether to pitch on the call
   *  before opening the prep doc. */
  llmFitScore: number;
  llmFitLabel: string;
  /** Top key-finding from the prep notes — the one bullet Anthony
   *  should walk into the call with already loaded. */
  topFinding: string;
  /** Signed URLs for the artifacts. Both 90-day TTL. */
  roadmapPdfUrl: string;
  prepNotesUrl: string;
  /** Buyer's dashboard URL — Anthony jumps to it during the call
   *  to walk through the heatmap with them. */
  dashboardUrl: string;
};

export function StrategistPrepEmail(props: StrategistPrepEmailProps) {
  const pitchFlag = props.llmFitScore >= 4 ? 'YES' : 'NO';
  return (
    <EmailLayout
      preview={`Tomorrow's audit call: ${props.businessName} (${props.trade}, ${props.market}) — TurfScore ${props.currentTurfScore}, LLM Fit ${props.llmFitScore}/5`}
    >
      <H1>Tomorrow&rsquo;s audit call: {props.businessName}</H1>

      <P>
        <strong>{props.trade}</strong> · {props.market} · scheduled{' '}
        <strong>{props.scheduledCallTime}</strong>
      </P>

      <FactStrip
        items={[
          { label: 'TurfScore', value: `${props.currentTurfScore} → ${props.projectedTurfScore}` },
          { label: 'LLM Fit', value: `${props.llmFitScore}/5 — ${props.llmFitLabel}` },
          { label: 'Pitch LLM', value: pitchFlag },
        ]}
      />

      <P>
        <strong>Top finding:</strong> {props.topFinding}
      </P>

      <P>
        Roadmap PDF is the buyer-facing deliverable — review it before
        the call so you know what they&rsquo;ll see when you send it
        post-call. Prep notes are operator-only with the talking points,
        objections, and (if applicable) the pre-written LLM segue.
      </P>

      <PrimaryButton href={props.roadmapPdfUrl}>
        Open Roadmap PDF →
      </PrimaryButton>
      <SecondaryButton href={props.prepNotesUrl}>
        Open Strategist Prep Notes →
      </SecondaryButton>

      <PSmall>
        <a
          href={props.dashboardUrl}
          style={{ color: '#a1a1aa', textDecoration: 'underline' }}
        >
          Open buyer&rsquo;s TurfMap dashboard
        </a>{' '}
        — for the live heatmap walkthrough on the call.
      </PSmall>
    </EmailLayout>
  );
}
