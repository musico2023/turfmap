/**
 * Scan-ready notification — sent when the buyer's first scan
 * completes (or any scheduled scan completes for a Pulse subscriber,
 * post-Phase 2).
 *
 * Surfaces the actual TurfScore + Reach + Rank inline so the buyer
 * has immediate context before clicking through. The PDF is
 * attached at the dispatch layer (sendScanReady passes
 * `attachments` through), not embedded — keeps the email body
 * lightweight + readable across mobile clients.
 */

import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type ScanReadyEmailProps = {
  businessName: string;
  dashboardUrl: string;
  /** Optional metric snapshot. When provided, shows the buyer
   *  their score family at a glance. Omit when the calling code
   *  doesn't have the numbers handy — the email still works as
   *  a "your map is ready, click here" notification. */
  metrics?: {
    turfScore: number;
    turfReach: number;
    turfRank: number | null;
  };
  /** True when the buyer's PDF report is being attached at dispatch
   *  time — we mention it inline so they know to look in their
   *  attachments rather than the inbox preview. */
  hasPdfAttachment?: boolean;
};

export function ScanReadyEmail({
  businessName,
  dashboardUrl,
  metrics,
  hasPdfAttachment,
}: ScanReadyEmailProps) {
  return (
    <EmailLayout
      preview={`Your TurfMap is ready — ${businessName}`}
    >
      <H1>Your map&rsquo;s ready.</H1>
      <P>
        We finished the 81-point geo-grid scan for{' '}
        <strong>{businessName}</strong>. Open your dashboard to see the
        heatmap, your TurfScore, and the AI Coach playbook.
      </P>

      {metrics && (
        <FactStrip
          items={[
            { label: 'TurfScore', value: `${metrics.turfScore} / 100` },
            { label: 'Reach', value: `${metrics.turfReach}%` },
            {
              label: 'Rank',
              value:
                metrics.turfRank != null
                  ? `${metrics.turfRank.toFixed(1)} / 3`
                  : '—',
            },
          ]}
        />
      )}

      <PrimaryButton href={dashboardUrl}>View my TurfMap →</PrimaryButton>

      {hasPdfAttachment && (
        <PSmall>Your PDF report is attached.</PSmall>
      )}
    </EmailLayout>
  );
}
