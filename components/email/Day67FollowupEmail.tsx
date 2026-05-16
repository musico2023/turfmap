/**
 * Day-67 buyer follow-up — fires 67 days after the strategist call
 * completes IF the 60-day check-in is still unscheduled. Same Cal.com
 * link as the day-53 prompt, slightly more direct copy.
 *
 * Operator side: a Slack notification also fires for buyers who hit
 * day-67 without scheduling, so Anthony can reach out manually if
 * the email doesn't land.
 */

import { EmailLayout, H1, P, PSmall, PrimaryButton } from './EmailLayout';

export type Day67FollowupEmailProps = {
  businessName: string;
  bookingUrl: string;
  dashboardUrl: string;
};

export function Day67FollowupEmail(props: Day67FollowupEmailProps) {
  return (
    <EmailLayout
      preview={`Quick nudge on your 60-day check-in`}
    >
      <H1>Quick nudge.</H1>

      <P>
        Haven&rsquo;t heard back on the 60-day check-in for{' '}
        <strong>{props.businessName}</strong>{' '}— wanted to make sure
        the email didn&rsquo;t get buried.
      </P>

      <P>
        We&rsquo;re past the 60-day mark, which means your 30-day
        re-scan is locked in and we should look at it together. The
        call takes 20 minutes and the questions we&rsquo;ll work
        through:
      </P>

      <P>
        — Did the Lift Promise fire? (We&rsquo;ll check the math
        before the call so you don&rsquo;t need to.)
        <br />
        — What&rsquo;s shifted in your map vs. when we started?
        <br />
        — What does the next 90 days look like — same plan, harder
        push, or pivot to demand-side work?
      </P>

      <PrimaryButton href={props.bookingUrl}>
        Pick a time →
      </PrimaryButton>

      <P>
        Or just reply with a quick &ldquo;we&rsquo;re good, no call
        needed&rdquo; and I&rsquo;ll send a written re-scan recap
        instead.
      </P>

      <PSmall>
        <a
          href={props.dashboardUrl}
          style={{ color: '#a1a1aa', textDecoration: 'underline' }}
        >
          See your latest scan
        </a>
        .
      </PSmall>
    </EmailLayout>
  );
}
