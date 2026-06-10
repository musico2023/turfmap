/**
 * PulseRecoveryEmail — 2-touch drip for score_unlock buyers who
 * completed their $49 unlock but didn't activate the free Pulse
 * trial on /order/success.
 *
 * Limited-time offer: an EXTENDED 60-day free trial (vs the
 * standard 30 days) for buyers who activate via this recovery
 * email's deep link within 72 hours of unlock. Doubles the
 * perceived value at near-zero marginal cost — DataForSEO scan
 * cost is ~$0.06/scan × 4 scans/month = ~$0.24/month per client,
 * so 30 extra free days runs us pennies.
 *
 * Touch schedule:
 *   touch_1 — T+48h ("You've left 2 days of competitor moves
 *              unwatched")
 *   touch_2 — T+5d  ("Last reminder — 60-day trial offer expires
 *              in [N]h")
 *
 * The CTA links to /order/success?session_id=<sid>&reopen=pulse —
 * the page reads `reopen=pulse` and (a) resets pulseChoice to
 * 'pending' so the panel re-renders, (b) tells PulseAttachPanel
 * to render in "extended trial" mode (60-day language + the
 * activation API call carries extended_trial=true so the resulting
 * Stripe Checkout writes trial_period_days: 60 instead of 30).
 *
 * Cancelled if Pulse attaches (Stripe webhook for the trial
 * subscription created event). Independent of the audit recovery
 * drip — buyers can convert audit but skip Pulse, or vice versa,
 * and each gets its own cancellation lane.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type PulseRecoveryStage = 'touch_1' | 'touch_2';

export type PulseRecoveryEmailProps = {
  /** Business name from the original /prove-it submission. Anchors
   *  the copy to the buyer's actual storefront. Optional. */
  businessName?: string | null;
  /** /order/success URL with ?reopen=pulse appended. Reopens the
   *  Pulse panel in extended-trial mode. */
  reopenUrl: string;
  /** Which touch this email represents. */
  stage: PulseRecoveryStage;
  /** Hours remaining until the 72-hour extended-trial offer expires.
   *  Touch 1 (T+48h) typically reads ~24h. Touch 2 (T+5d) reads "0
   *  hours — last chance" but we ALWAYS round-up to at least 1 hour
   *  in the body so the copy reads cleanly. */
  hoursRemaining: number;
};

type StageCopy = {
  preview: string;
  headline: string;
  body: React.ReactNode;
  cta: string;
  footnote: React.ReactNode;
};

function forBusiness(businessName?: string | null): React.ReactNode {
  return businessName ? (
    <>
      {' '}
      for <strong>{businessName}</strong>
    </>
  ) : null;
}

function copyForStage(
  stage: PulseRecoveryStage,
  businessName: string | null,
  hoursRemaining: number
): StageCopy {
  const biz = businessName?.trim() || null;
  const bizLabel = biz ?? 'your business';
  const safeHours = Math.max(1, Math.round(hoursRemaining));

  if (stage === 'touch_1') {
    return {
      preview: `2 days of competitor moves you can't see — 60-day trial inside`,
      headline: `Your competitors moved this week.`,
      body: (
        <>
          You unlocked your TurfMap{forBusiness(biz)} two days ago.
          In that time, your top-3 competitors may have added reviews,
          changed categories, or grabbed cells you used to rank in.
          You can&rsquo;t see any of it without a fresh scan.
          <br />
          <br />
          That&rsquo;s what <strong>Pulse</strong>{' '}does — it
          re-scans you <strong>every Monday</strong>, alerts you
          when your TurfScore moves more than ±5, and refreshes
          your AI Coach Fix List each week.
          <br />
          <br />
          Because you didn&rsquo;t activate at checkout, I&rsquo;m
          opening a one-time offer:{' '}
          <strong>60 days free instead of 30</strong> — double the
          standard trial. Activate within{' '}
          <strong>{safeHours} hours</strong>{' '}and Pulse runs free
          through the end of next month before any charge.
        </>
      ),
      cta: 'Activate 60-day trial →',
      footnote: (
        <>
          Free for 60 days, then $39/mo. Cancel anytime before day 61
          to pay nothing. Offer expires in {safeHours} hours.
        </>
      ),
    };
  }

  // touch_2 — final, 72h-window closing
  return {
    preview: `Final ${safeHours}h: 60-day Pulse trial offer expires soon`,
    headline: `Last reminder.`,
    body: (
      <>
        The <strong>60-day Pulse trial</strong>{' '}offer I extended for{' '}
        {bizLabel} expires in <strong>{safeHours} hours</strong>.
        After that, the standard 30-day trial is still available —
        but the extra month is gone.
        <br />
        <br />
        What you get during the trial:
        <br />
        — <strong>Weekly scans</strong> (4 scans/month vs $99
        each one-off)
        <br />
        — <strong>Drop alerts</strong>{' '}when your TurfScore moves ±5+
        <br />
        — <strong>Refreshed AI Coach Fix List</strong>{' '}every week
        <br />
        — All of it free for the first 60 days
        <br />
        <br />
        If the timing&rsquo;s wrong or the trial isn&rsquo;t right
        for {bizLabel}, just hit reply and tell me — I read every
        response.
      </>
    ),
    cta: `Activate 60-day trial — ${safeHours}h left →`,
    footnote: (
      <>
        — Anthony, TurfMap. Free for 60 days, then $39/mo. Cancel
        anytime before day 61 to pay nothing.
      </>
    ),
  };
}

export function PulseRecoveryEmail({
  businessName,
  reopenUrl,
  stage,
  hoursRemaining,
}: PulseRecoveryEmailProps) {
  const copy = copyForStage(stage, businessName ?? null, hoursRemaining);
  return (
    <EmailLayout preview={copy.preview}>
      <H1>{copy.headline}</H1>
      <P>{copy.body}</P>
      <PrimaryButton href={reopenUrl}>{copy.cta}</PrimaryButton>
      <PSmall>{copy.footnote}</PSmall>
    </EmailLayout>
  );
}
