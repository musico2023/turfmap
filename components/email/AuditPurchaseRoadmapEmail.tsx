/**
 * Operator-facing email fired when a Visibility Audit buyer completes
 * checkout. Lands in anthony@fourdots.io's inbox with the freshly-
 * generated 90-Day Roadmap PDF attached so Anthony has it in hand
 * BEFORE the strategist call (or before reaching out, if the buyer
 * hasn't booked yet).
 *
 * Distinct from the T-24h pre-call Strategist Prep email:
 *   - This fires at PURCHASE time, ~30-60s after Stripe Checkout.
 *   - Contains the Roadmap PDF only; no separate Strategist Prep Notes
 *     document (that's still generated fresh at T-24h since it
 *     references the scheduled call time + freshest data).
 *
 * The buyer does NOT get the PDF automatically — Anthony sends it
 * manually after the call so the deliverable arrives with strategist
 * context, not as a cold automated attachment.
 */

import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditPurchaseRoadmapEmailProps = {
  /** Buyer business name. */
  businessName: string;
  /** Human-readable tier label — "Visibility Audit" or "Strategy
   *  Session". Drives the subject + body copy so the inbox preview
   *  reads correctly regardless of which tier the buyer purchased. */
  tierLabel: string;
  /** Buyer email — surfaced inline so Anthony can copy/forward
   *  without opening the agency dashboard first. */
  buyerEmail: string;
  /** Buyer phone — same rationale. */
  buyerPhone: string | null;
  /** Buyer market (city / region from the Mapbox pick). */
  market: string;
  /** Primary keyword from intake. */
  trade: string;
  /** TurfScore at purchase. */
  startingTurfScore: number;
  /** Projected score after 30-day Roadmap execution. */
  projectedTurfScore: number;
  /** LLM Fit Score (1-5). Frames the buyer's qualification context. */
  llmFitScore: number;
  /** Diagnosis blurb from the AI Roadmap Generator. Quoted inline so
   *  Anthony has a quick read on the framing without opening the PDF. */
  diagnosisPreview: string;
  /** Agency-side dashboard for the buyer's client record. */
  agencyDashboardUrl: string;
};

export function AuditPurchaseRoadmapEmail({
  businessName,
  tierLabel,
  buyerEmail,
  buyerPhone,
  market,
  trade,
  startingTurfScore,
  projectedTurfScore,
  llmFitScore,
  diagnosisPreview,
  agencyDashboardUrl,
}: AuditPurchaseRoadmapEmailProps) {
  const lift = Math.max(0, projectedTurfScore - startingTurfScore);
  return (
    <EmailLayout
      preview={`New ${tierLabel} buyer: ${businessName} — Roadmap PDF attached`}
    >
      <H1>New {tierLabel} buyer Roadmap.</H1>
      <P>
        <strong>{businessName}</strong>{' '}just completed a {tierLabel}{' '}
        purchase. Their 90-Day Roadmap PDF is attached — review
        before the strategist call (or before manual outreach if
        they haven&apos;t booked Cal.com yet).
      </P>

      <FactStrip
        items={[
          { label: 'Starting TurfScore', value: `${startingTurfScore} / 100` },
          {
            label: '30-day target',
            value: `${projectedTurfScore} / 100 (+${lift})`,
          },
          { label: 'LLM Fit', value: `${llmFitScore} / 5` },
        ]}
      />

      <P>
        <strong>Buyer:</strong> {buyerEmail}
        {buyerPhone ? ` · ${buyerPhone}` : ''}
        <br />
        <strong>Market:</strong> {market}
        <br />
        <strong>Keyword:</strong> {trade}
      </P>

      <P>
        <strong>Diagnosis:</strong> {diagnosisPreview}
      </P>

      <PrimaryButton href={agencyDashboardUrl}>
        Open buyer in agency dashboard →
      </PrimaryButton>

      <PSmall>
        The Roadmap PDF is attached. The T-24h cron will regenerate a
        fresh version + Strategist Prep Notes once the buyer books
        their Cal.com slot.
      </PSmall>
    </EmailLayout>
  );
}
