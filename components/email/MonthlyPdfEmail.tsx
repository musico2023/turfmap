/**
 * Monthly PDF report email — sent on the 1st of each month with
 * the buyer's latest scan rendered as a TurfReport PDF attached.
 *
 * The cron that fires this builds the PDF buffer and passes it as
 * an attachment via sendEmail's `attachments` array; this template
 * is the email body the buyer reads while opening the attachment.
 */

import { EmailLayout, H1, P, PSmall, PrimaryButton } from './EmailLayout';

export type MonthlyPdfEmailProps = {
  businessName: string;
  /** ISO date (YYYY-MM-DD) of the scan the PDF was rendered from.
   *  Surfaced in the body so the buyer can pattern-match this
   *  email against the dashboard view they'd see if they clicked
   *  through. */
  scanDate: string;
  /** Buyer-facing portal URL. */
  portalUrl: string;
};

export function MonthlyPdfEmail({
  businessName,
  scanDate,
  portalUrl,
}: MonthlyPdfEmailProps) {
  return (
    <EmailLayout
      preview={`Your monthly TurfMap is ready — ${businessName}`}
    >
      <H1>Your monthly TurfMap is ready.</H1>
      <P>
        <strong>{businessName}</strong>{' '}— {scanDate}. The full PDF
        report is attached, with the heatmap, score family, and AI
        Coach playbook on its own page.
      </P>

      <PrimaryButton href={portalUrl}>Open dashboard →</PrimaryButton>

      <PSmall>
        Your dashboard always shows the freshest scan; the PDF is a
        snapshot for sharing with stakeholders or filing for the
        record.
      </PSmall>
    </EmailLayout>
  );
}
