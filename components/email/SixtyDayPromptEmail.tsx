/**
 * Day-53 buyer 60-day check-in prompt — fires 53 days after the
 * strategist call completes (7 days before the 60-day target).
 *
 * This is the buyer-led scheduling flow per the spec: we prompt the
 * buyer to pick their own time via a Cal.com link tagged with the
 * 60-day-check-in event metadata. If they don't book within 14 days,
 * the day-67 follow-up cron sends a second nudge + a Slack alert
 * lands in #llm-leads.
 */

import { EmailLayout, FactStrip, H1, P, PSmall, PrimaryButton } from './EmailLayout';

export type SixtyDayPromptEmailProps = {
  businessName: string;
  /** Days since the strategist call completed. For the standard
   *  cron-driven send this is 53; for an operator-triggered manual
   *  send it could differ. Surfaced in the body copy as "it's been
   *  about 60 days." */
  daysSinceCall: number;
  /** Buyer's starting TurfScore at audit time. */
  startingTurfScore: number;
  /** 30-day target from the original Roadmap. */
  projectedTurfScore: number;
  /** Most recent re-scan TurfScore — null when the 30-day re-scan
   *  hasn't fired yet (rare at day 53 but possible if the buyer's
   *  scan pipeline stalled). */
  currentTurfScore: number | null;
  /** Cal.com URL for the 60-day check-in booking. Tagged with
   *  60day=1 so the webhook routes correctly. */
  bookingUrl: string;
  /** Buyer dashboard for the re-scan results. */
  dashboardUrl: string;
};

export function SixtyDayPromptEmail(props: SixtyDayPromptEmailProps) {
  const liftDelta =
    props.currentTurfScore != null
      ? props.currentTurfScore - props.startingTurfScore
      : null;
  return (
    <EmailLayout
      preview={`Your TurfMap 60-day check-in — pick a time`}
    >
      <H1>Your 60-day check-in.</H1>

      <P>
        Quick update: it&rsquo;s been about {props.daysSinceCall}{' '}
        days since we walked through your visibility roadmap for{' '}
        <strong>{props.businessName}</strong>.
        {props.currentTurfScore != null
          ? ' Your 30-day re-scan completed — let&rsquo;s review where you are and tune the next 90 days.'
          : ' Time to review your progress and adjust the plan for the next 90 days.'}
      </P>

      <FactStrip
        items={[
          { label: 'Started at', value: String(props.startingTurfScore) },
          { label: '30-day target', value: String(props.projectedTurfScore) },
          props.currentTurfScore != null
            ? {
                label: 'Latest scan',
                value: `${props.currentTurfScore}${liftDelta != null && liftDelta >= 0 ? ` (+${liftDelta})` : liftDelta != null ? ` (${liftDelta})` : ''}`,
              }
            : { label: 'Latest scan', value: 'pending' },
        ]}
      />

      <PrimaryButton href={props.bookingUrl}>
        Schedule 60-day check-in →
      </PrimaryButton>

      <P>
        Already crushing the roadmap and want to skip the call? Just
        reply to this email and let me know how it&rsquo;s going.
      </P>

      <PSmall>
        <a
          href={props.dashboardUrl}
          style={{ color: '#a1a1aa', textDecoration: 'underline' }}
        >
          See your re-scan results
        </a>
        .
      </PSmall>
    </EmailLayout>
  );
}
