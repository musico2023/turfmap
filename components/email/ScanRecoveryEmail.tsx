/**
 * Scan cart-abandonment recovery email — sent to buyers who reached
 * Stripe Checkout for a TurfScan but never paid (the session expired
 * unpaid, firing `checkout.session.expired`).
 *
 * Three escalating touches, fired off the single expiry event:
 *
 *   touch_1 — ~1h after abandonment ("you were one step away")
 *   touch_2 — +24h ("your competitors aren't waiting")
 *   touch_3 — +72h (final, soft scarcity + hit-reply offer)
 *
 * Touch 1 sends immediately from the webhook; touches 2 & 3 are queued
 * via Resend scheduled-send at create time (same mechanism as
 * AuditBookingNudge / AuditCallReminder — no sub-daily Vercel Cron,
 * which Hobby tier can't run). All three are cancelled if the buyer
 * recovers (completes a later purchase) — see /api/orders/fulfill.
 *
 * No discount by design: the /scan funnel is already the discounted
 * entry price ($49 vs the $99 list), so the recovery play is a resume
 * link, not a further markdown. The CTA deep-links back to /intake with
 * the buyer's business name + keyword prefilled so finishing is one tap
 * away (Stripe sessions are single-use, so we can't resume the expired
 * one — we send them back through a fresh, pre-filled intake instead).
 *
 * One component, three copy variants — mirrors AuditBookingNudgeEmail so
 * the visual rhythm stays consistent across the buyer's inbox.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type ScanRecoveryStage = 'touch_1' | 'touch_2' | 'touch_3';

export type ScanRecoveryEmailProps = {
  /** Business the buyer entered at intake. Optional — falls back to a
   *  generic phrasing when the abandoned session had no business name
   *  stamped (shouldn't happen for scan_intake, but the template stays
   *  graceful). */
  businessName?: string | null;
  /** Primary keyword the buyer wanted to rank for. Used to make the
   *  copy concrete ("…for ‘emergency plumber’"). Optional. */
  keyword?: string | null;
  /** Pre-filled resume URL — /intake with tier + business + keyword in
   *  the query string so the buyer lands on a form that's already
   *  filled out. */
  resumeUrl: string;
  /** Which touch this email represents. Drives headline, body, CTA. */
  stage: ScanRecoveryStage;
};

type StageCopy = {
  preview: string;
  headline: string;
  body: React.ReactNode;
  cta: string;
  footnote: React.ReactNode;
};

/** Renders "for <business>" / "for ‘<keyword>’" fragments only when the
 *  data is present, so copy never reads "your scan for ." on sparse
 *  sessions. */
function forBusiness(businessName?: string | null): React.ReactNode {
  return businessName ? (
    <>
      {' '}
      for <strong>{businessName}</strong>
    </>
  ) : null;
}

function copyForStage(
  stage: ScanRecoveryStage,
  businessName?: string | null,
  keyword?: string | null
): StageCopy {
  const biz = businessName?.trim() || null;
  const kw = keyword?.trim() || null;
  const bizLabel = biz ?? 'your business';

  if (stage === 'touch_1') {
    return {
      preview: `You were one step away from your TurfMap${biz ? ` — ${biz}` : ''}`,
      headline: 'You were one step away.',
      body: (
        <>
          You started a TurfScan{forBusiness(biz)} but didn&apos;t
          finish checkout — so the 81-point geo-grid scan + your AI
          Coach Fix List never ran. No charge was made.
          <br />
          <br />
          {kw ? (
            <>
              We still have your details ready to map{' '}
              <strong>{bizLabel}</strong> for{' '}
              <strong>&lsquo;{kw}&rsquo;</strong> across your whole
              service area.
              <br />
              <br />
              The results turn into three prioritized actions you can
              take this week.
            </>
          ) : (
            <>
              We still have your details ready — picking up where you
              left off takes about a minute.
              <br />
              <br />
              You&apos;ll get the full scan plus the Fix List with
              three prioritized actions.
            </>
          )}
        </>
      ),
      cta: 'Finish my scan →',
      footnote: (
        <>
          The scan + Fix List land within a minute of payment, and
          you can request a full refund within 24h with a one-line
          email.
        </>
      ),
    };
  }

  if (stage === 'touch_2') {
    return {
      preview: `Your competitors are already on the map — ${bizLabel}`,
      headline: "Your competitors are already on the map.",
      body: (
        <>
          Every day without a TurfScan is a day you don&apos;t know
          where <strong>{bizLabel}</strong> actually ranks
          {kw ? (
            <>
              {' '}
              for <strong>&lsquo;{kw}&rsquo;</strong>
            </>
          ) : null}
          {' '}— or which competitors are eating your visibility in
          the neighborhoods that matter.
          <br />
          <br />
          The scan maps all 81 grid points so you can see exactly
          where you show up and where you don&apos;t.
          <br />
          <br />
          The AI Coach Fix List turns those gaps into three prioritized
          actions named to your real audit data — not generic advice.
        </>
      ),
      cta: 'Run my TurfScan →',
      footnote: (
        <>
          Your details are still saved — the link above drops you back
          on a pre-filled form. Scan + Fix List both land within a
          minute of payment.
        </>
      ),
    };
  }

  // touch_3 — final, soft scarcity + personal hit-reply offer.
  return {
    preview: `Last reminder about your TurfScan + Fix List — ${bizLabel}`,
    headline: 'Last reminder about your scan + Fix List.',
    body: (
      <>
        This is the last nudge about the TurfScan you started
        {forBusiness(biz)}.
        <br />
        <br />
        We&apos;ll hold your details for now, but we clear out
        incomplete checkouts after a while. After that you&apos;d be
        starting from scratch on both the 81-point map and the
        three-action Fix List.
        <br />
        <br />
        If something about the checkout got in the way, just hit reply
        and tell me what happened — I read every response.
      </>
    ),
    cta: 'Finish my scan →',
    footnote: <>— Anthony, TurfMap. Reply anytime — a real person sees it.</>,
  };
}

export function ScanRecoveryEmail({
  businessName,
  keyword,
  resumeUrl,
  stage,
}: ScanRecoveryEmailProps) {
  const copy = copyForStage(stage, businessName, keyword);
  return (
    <EmailLayout preview={copy.preview}>
      <H1>{copy.headline}</H1>
      <P>{copy.body}</P>
      <PrimaryButton href={resumeUrl}>{copy.cta}</PrimaryButton>
      <PSmall>{copy.footnote}</PSmall>
    </EmailLayout>
  );
}
