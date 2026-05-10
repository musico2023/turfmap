/**
 * Pulse trial-ending reminder — sent ~3 days before the trial ends
 * (day 28 of a 30-day trial). Triggered by Stripe's
 * `customer.subscription.trial_will_end` webhook event.
 *
 * Goals:
 *   - Re-anchor on the trial value: surface concrete numbers
 *     ("[X] scans run, current TurfScore [Y]") so the buyer sees
 *     what they'd be losing if they cancel.
 *   - Make BOTH paths effortless:
 *       Manage subscription → portal billing
 *       Cancel trial         → portal cancel-trial flow (one-click)
 *   - Frame the default behavior clearly: doing nothing = continued
 *     access at $39/mo from the chargeDate.
 *
 * The email's visual treatment mirrors the rest of the React Email
 * suite (EmailLayout shell, lime accents, primary button + small
 * link affordance for the secondary action).
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
  SecondaryLink,
  TierBadge,
} from './EmailLayout';

export type PulseTrialEndingEmailProps = {
  /** Buyer's business name — personalizes the headline. */
  businessName: string;
  /** Number of scans run during the trial so far. Reads
   *  concretely ("we've run 4 scans") rather than abstractly
   *  ("we've been monitoring you"). */
  scanCount: number;
  /** Current TurfScore from the latest scan. Null if no scans
   *  ran during the trial — the template renders a fallback line
   *  in that case. */
  currentTurfScore: number | null;
  /** Date the first $39 charge will hit the buyer's card.
   *  Pre-formatted ("July 18, 2025") so the email layer doesn't
   *  have to know the buyer's locale conventions. */
  chargeDate: string;
  /** Portal URL for managing the subscription (invoices, payment
   *  methods, billing-cycle change). */
  manageSubscriptionUrl: string;
  /** Direct deep-link URL to the portal's cancel-trial flow. The
   *  buyer lands on a confirmation modal and a single confirm
   *  click cancels — no form, no email reply. */
  cancelTrialUrl: string;
};

export function PulseTrialEndingEmail({
  businessName,
  scanCount,
  currentTurfScore,
  chargeDate,
  manageSubscriptionUrl,
  cancelTrialUrl,
}: PulseTrialEndingEmailProps) {
  // "We've run [X] scans for you" reads better than "We have run X
  // scans"; the conversational tone matches the rest of the email
  // suite. Singularize the noun when scanCount === 1.
  const scanWord = scanCount === 1 ? 'scan' : 'scans';
  return (
    <EmailLayout preview="Your TurfMap Pulse trial ends in 3 days.">
      <P>
        <TierBadge tier="pulse" />
      </P>
      <H1>Your TurfMap Pulse trial ends in 3 days.</H1>
      <P>
        We&rsquo;ve run{' '}
        <strong>
          {scanCount} {scanWord}
        </strong>{' '}
        for {businessName} so far.
        {currentTurfScore !== null ? (
          <>
            {' '}Your TurfScore is currently{' '}
            <strong>{currentTurfScore}</strong>.
          </>
        ) : (
          // Fallback when no scans landed during the trial — rare
          // but possible if the buyer cancelled all scans or the
          // weekly cron skipped them.
          <> Your weekly map will keep updating once Pulse continues.</>
        )}
      </P>
      <P>
        On <strong>{chargeDate}</strong>, your card will be charged{' '}
        <strong>$39</strong>{' '}to continue Pulse.
      </P>
      <P>
        <strong>To keep watching:</strong>{' '}do nothing. We&rsquo;ll
        keep re-scanning every Monday and the AI Coach playbook will
        refresh weekly.
      </P>

      <PrimaryButton href={manageSubscriptionUrl}>
        Manage subscription →
      </PrimaryButton>

      <P>
        <SecondaryLink href={cancelTrialUrl}>
          Cancel trial — one click, no charge
        </SecondaryLink>
      </P>

      <PSmall>
        Cancellation takes effect at the end of your trial — you
        keep Pulse access through {chargeDate} but your card
        won&rsquo;t be charged. No questions, no email reply
        required.
      </PSmall>
    </EmailLayout>
  );
}
