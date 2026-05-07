/**
 * Generic alert email shell. Used for the four post-scan alert types
 * dispatched from lib/alerts/dispatch.ts:
 *   - score_movement
 *   - competitor_entries
 *   - momentum_reversal
 *   - cell_changes
 *
 * Replaces the hand-rolled emailShell() that lib/alerts/dispatch.ts
 * was using before — all buyer-facing emails now share the EmailLayout
 * brand shell instead of a divergent inline HTML template.
 *
 * Each alert renderer passes its specific headline + body JSX as
 * children, plus a CTA URL/label. The shell handles the dark/lime
 * brand frame, footer, and preview text.
 */

import {
  EmailLayout,
  H1,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AlertEmailProps = {
  preview: string;
  headline: string;
  /** Body paragraphs / lists. Pass JSX so renderers can style numbers
   *  with brand colors (lime for up, amber for down). */
  children?: React.ReactNode;
  ctaUrl: string;
  ctaLabel: string;
  /** Optional small footer note above the standard EmailLayout footer.
   *  Renders nothing when omitted. */
  footnote?: string;
};

export function AlertEmail({
  preview,
  headline,
  children,
  ctaUrl,
  ctaLabel,
  footnote,
}: AlertEmailProps) {
  return (
    <EmailLayout preview={preview}>
      <H1>{headline}</H1>
      {children}
      <PrimaryButton href={ctaUrl}>{ctaLabel}</PrimaryButton>
      {footnote && <PSmall>{footnote}</PSmall>}
    </EmailLayout>
  );
}
