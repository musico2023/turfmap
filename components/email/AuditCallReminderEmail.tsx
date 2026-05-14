/**
 * Audit-call reminder — sent ~20 minutes after a Visibility Audit
 * purchase if the buyer hasn't booked their strategist call on
 * Cal.com yet. Triggered by the audit-call-reminders cron job, not
 * inline at fulfill time, so the dispatch is reliable across
 * function timeouts + at-most-once per buyer.
 *
 * Goal: re-anchor the booking step without nagging. Friendly tone,
 * a single primary CTA, no second action competing for attention.
 * The 90-Day Roadmap PDF timing is repeated so the buyer
 * understands why booking matters now (the rest of the deliverable
 * stack is gated on the call).
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditCallReminderEmailProps = {
  businessName: string;
  /** Cal.com URL pre-filled with the buyer's email + business name.
   *  Same URL we sent in the order-confirmation; we re-send it
   *  here so the buyer doesn't have to dig back through their
   *  inbox. */
  bookingUrl: string;
};

export function AuditCallReminderEmail({
  businessName,
  bookingUrl,
}: AuditCallReminderEmailProps) {
  return (
    <EmailLayout
      preview={`Pick a time for your TurfMap strategist call — ${businessName}`}
    >
      <H1>One more step: book your strategist call.</H1>
      <P>
        Hey — your Visibility Audit is paid for, but we need a
        30-minute slot on your calendar before the analysis can
        start. The strategist walks through your map with you,
        confirms the verticals, and tunes the 90-Day Roadmap to your
        business in real time.
      </P>

      <PrimaryButton href={bookingUrl}>
        Pick your time →
      </PrimaryButton>

      <PSmall>
        Once booked, your 90-Day Roadmap PDF lands in your inbox
        within 24 hours of the call. If you&rsquo;d rather coordinate
        directly, just hit reply.
      </PSmall>
    </EmailLayout>
  );
}
