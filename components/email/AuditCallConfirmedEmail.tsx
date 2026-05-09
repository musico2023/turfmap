/**
 * Audit-call confirmation — fires when Cal.com sends BOOKING_CREATED
 * for a Visibility Audit buyer. Acknowledges the locked-in time
 * and resets expectations on what happens next.
 *
 * Cal.com sends its own calendar invite + confirmation — this email
 * is the TurfMap-branded version, so the buyer sees the same shell
 * + tone as the order confirmation, and we own the relationship
 * without forcing them through Cal.com's UI for everything.
 */

import {
  EmailLayout,
  FactStrip,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditCallConfirmedEmailProps = {
  businessName: string;
  /** Pre-formatted call time, e.g. "Tuesday, Aug 12 at 2:00 pm EDT".
   *  Caller computes from Cal.com webhook payload (startTime + the
   *  buyer's timezone) so the email layer doesn't need date-fns. */
  scheduledAt: string;
  /** Cal.com booking URL — surfaces a small "manage / reschedule"
   *  affordance below the primary content. Cal.com handles the
   *  reschedule UX itself; we just link to it. */
  manageBookingUrl: string;
  /** Portal link so the buyer can poke around the dashboard while
   *  they wait for the call. */
  dashboardUrl: string;
};

export function AuditCallConfirmedEmail({
  businessName,
  scheduledAt,
  manageBookingUrl,
  dashboardUrl,
}: AuditCallConfirmedEmailProps) {
  return (
    <EmailLayout
      preview={`Strategist call confirmed for ${scheduledAt}`}
    >
      <H1>You&rsquo;re booked.</H1>
      <P>
        Your TurfMap strategist call for{' '}
        <strong>{businessName}</strong> is confirmed — see you on the
        call.
      </P>

      <FactStrip
        items={[
          { label: 'When', value: scheduledAt },
          { label: 'Length', value: '30 minutes' },
        ]}
      />

      <P>
        <strong>Before the call:</strong> nothing required. We&rsquo;ll
        come prepared with your map, the AI Coach Fix List, and a
        first cut of the 90-Day Roadmap. The call is for confirming
        priorities + tuning to your business.
      </P>

      <P>
        <strong>After the call:</strong> the finalized 90-Day Roadmap
        PDF lands in your inbox within 24 hours. From there we run a
        30-day re-scan to measure progress and a 60-day check-in
        call to adjust the plan.
      </P>

      <PrimaryButton href={dashboardUrl}>Open my TurfMap →</PrimaryButton>

      <PSmall>
        Need to reschedule?{' '}
        <a
          href={manageBookingUrl}
          style={{ color: '#a1a1aa', textDecoration: 'underline' }}
        >
          Manage your booking
        </a>{' '}
        — or hit reply, we&rsquo;re flexible.
      </PSmall>
    </EmailLayout>
  );
}
