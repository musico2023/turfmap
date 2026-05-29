/**
 * Audit booking-nudge email — sent to audit/strategy buyers who
 * haven't booked their Cal.com strategist call yet. Follows the
 * single T+20m AuditCallReminder with three escalating nudges:
 *
 *   day_1 — friendly nudge ("just a reminder")
 *   day_3 — value reinforcement ("here's what's waiting on the call")
 *   day_7 — final automated nudge before operator escalation
 *
 * Each stage fires at most once per buyer (idempotency via the
 * audit_call_nudge_<stage>_sent_at gate stamped on lead_orders
 * metadata). Booking immediately stops the sequence — the cron
 * filters on audit_call_status === 'unbooked' and Cal.com's
 * BOOKING_CREATED webhook flips that to 'booked'.
 *
 * One component, three copy variants. Keeps the visual rhythm
 * consistent across stages while differentiating tone — by day 7
 * the buyer should sense that automated nudges are about to give
 * way to a personal email from Anthony.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditBookingNudgeStage = 'day_1' | 'day_3' | 'day_7';

export type AuditBookingNudgeEmailProps = {
  businessName: string;
  /** Pre-filled Cal.com booking URL — same one we sent in the
   *  order confirmation + the T+20m reminder. */
  bookingUrl: string;
  /** Which nudge stage this email represents. Drives the headline,
   *  body, and CTA microcopy. */
  stage: AuditBookingNudgeStage;
};

type StageCopy = {
  preview: string;
  headline: string;
  body: React.ReactNode;
  cta: string;
  footnote: React.ReactNode;
};

function copyForStage(stage: AuditBookingNudgeStage, businessName: string): StageCopy {
  if (stage === 'day_1') {
    return {
      preview: `Quick reminder — your Visibility Audit call for ${businessName}`,
      headline: 'Quick reminder: your audit walkthrough.',
      body: (
        <>
          Your Visibility Audit for <strong>{businessName}</strong>{' '}
          is paid for, but we still need a 30-minute slot on your
          calendar before the strategist walkthrough can run. Most
          buyers book within an hour — pick a time that works and
          we&apos;ll take it from there.
        </>
      ),
      cta: 'Pick your time →',
      footnote: (
        <>
          Already booked? You can ignore this — the calendar takes a
          minute or two to sync.
        </>
      ),
    };
  }

  if (stage === 'day_3') {
    return {
      preview: `Let's get your audit on the calendar — ${businessName}`,
      headline: "Let's get your audit on the calendar.",
      body: (
        <>
          Quick check-in. Your Visibility Audit is paid for and the
          analysis is queued up for <strong>{businessName}</strong>,
          but the strategist call is the unlock for the rest of the
          deliverable — competitor teardown, NAP fix list, and the
          tuned 90-Day Roadmap. The 30-minute slot is the only piece
          waiting on you.
        </>
      ),
      cta: 'Book the walkthrough →',
      footnote: (
        <>
          If a 30-minute call isn&apos;t the right format, just hit
          reply and we&apos;ll work something out async.
        </>
      ),
    };
  }

  // day_7 — last automated nudge, signal that personal outreach is next.
  return {
    preview: `Last reminder before I reach out personally — ${businessName}`,
    headline: 'Last automated reminder.',
    body: (
      <>
        I noticed your Visibility Audit for{' '}
        <strong>{businessName}</strong>{' '}
        still doesn&apos;t have a strategist call booked. This is the
        last automated nudge —
        if you don&apos;t pick a slot in the next day or two,
        I&apos;ll email you directly so we can sort out the
        deliverable, whether that means a call, an async walkthrough,
        or a refund if the timing has shifted.
      </>
    ),
    cta: 'Book my call →',
    footnote: (
      <>
        — Anthony, TurfMap. Reply to this email if you&apos;d rather
        coordinate directly.
      </>
    ),
  };
}

export function AuditBookingNudgeEmail({
  businessName,
  bookingUrl,
  stage,
}: AuditBookingNudgeEmailProps) {
  const copy = copyForStage(stage, businessName);
  return (
    <EmailLayout preview={copy.preview}>
      <H1>{copy.headline}</H1>
      <P>{copy.body}</P>
      <PrimaryButton href={bookingUrl}>{copy.cta}</PrimaryButton>
      <PSmall>{copy.footnote}</PSmall>
    </EmailLayout>
  );
}
