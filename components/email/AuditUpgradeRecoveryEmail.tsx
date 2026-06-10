/**
 * AuditUpgradeRecoveryEmail — 3-touch drip for score_unlock buyers
 * who completed their $49 unlock but skipped (or never clicked)
 * the $197 audit upgrade on /order/success.
 *
 * Real scarcity: the audit upgrade discount is gated server-side to
 * a 24-hour window from score_unlock fulfillment. After that, the
 * Stripe Checkout returns 410 and the buyer would have to pay $499
 * from scratch. The drip times itself INSIDE that window:
 *
 *   touch_1 — T+1h  ("Don't leave $302 on the table")
 *   touch_2 — T+8h  ("16 hours left to save $302")
 *   touch_3 — T+22h ("Final 2 hours")
 *
 * Touch_1 sends at T+1h via Resend scheduled-send; touches 2 and 3
 * are also scheduled at score_unlock fulfillment. All three are
 * cancelled if the buyer converts on the audit upgrade (either the
 * 1-click inline confirm path or the Stripe Checkout redirect path).
 *
 * Email CTA links to /order/success?session_id=<sid>&reopen=audit —
 * the parent page reads `reopen=audit` and resets upgradeChoice to
 * 'pending', re-showing the AuditUpgradePanel. No re-checkout
 * required, no email-form re-entry.
 *
 * Countdown rendering: no GIF infrastructure (third-party services
 * like timer.email are an extra moving part). We bake the remaining
 * hours into the body text at compose time — accurate to the
 * buyer's actual unlock moment, email-client-safe, no dynamic
 * rendering required at open time. The Touch 3 email surfaces the
 * exact wall-clock expiry timestamp ("expires at 3:42 PM EDT today")
 * so a buyer who opens the email RIGHT before the cutoff still has
 * an accurate read on how long they have.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type AuditUpgradeRecoveryStage = 'touch_1' | 'touch_2' | 'touch_3';

export type AuditUpgradeRecoveryEmailProps = {
  /** Business name the buyer entered on /prove-it. Anchors the copy
   *  to their actual business ("for Acme Plumbing"). Optional;
   *  template stays graceful when missing. */
  businessName?: string | null;
  /** Their TurfScore (0-100). Used in touch 2 to anchor the urgency
   *  ("you're at 28/100, here's how to lift it"). Optional. */
  turfScore?: number | null;
  /** /order/success URL with ?reopen=audit appended. The page reads
   *  that query param and resets upgradeChoice to 'pending', re-
   *  rendering the AuditUpgradePanel. */
  reopenUrl: string;
  /** Which touch this email represents. Drives subject + headline +
   *  body + footnote — everything that varies. */
  stage: AuditUpgradeRecoveryStage;
  /** Hours remaining until the 24h audit window closes, baked in
   *  at compose time. Used in body copy ("23 hours left", "16
   *  hours left"). Touch 3 also gets the absolute wall-clock
   *  cutoff time via cutoffTimeLabel. */
  hoursRemaining: number;
  /** Touch 3 only. Pre-formatted local-time string like
   *  "3:42 PM EDT today". Falls back to a generic phrase when
   *  not supplied. */
  cutoffTimeLabel?: string | null;
};

type StageCopy = {
  preview: string;
  headline: string;
  body: React.ReactNode;
  cta: string;
  footnote: React.ReactNode;
};

// Returns " for <strong>{Business}</strong>" with a leading space.
// Trailing space deliberately omitted — call sites use this either
// before " just finished." (own leading space) or before "." (no
// space needed).
function forBusiness(businessName?: string | null): React.ReactNode {
  return businessName ? (
    <>
      {' '}
      for <strong>{businessName}</strong>
    </>
  ) : null;
}

function copyForStage(
  stage: AuditUpgradeRecoveryStage,
  businessName: string | null,
  turfScore: number | null,
  hoursRemaining: number,
  cutoffTimeLabel: string | null
): StageCopy {
  const biz = businessName?.trim() || null;
  const bizLabel = biz ?? 'your business';
  const scoreText =
    typeof turfScore === 'number' && Number.isFinite(turfScore)
      ? String(Math.round(turfScore))
      : null;
  const safeHours = Math.max(1, Math.round(hoursRemaining));

  if (stage === 'touch_1') {
    return {
      preview: `Your audit upgrade is still here — save $302`,
      headline: `Don't leave $302 on the table.`,
      body: (
        <>
          You unlocked your TurfMap{forBusiness(biz)} earlier today —
          but you skipped the audit upgrade. That&apos;s a{' '}
          <strong>$197 audit</strong> (normally $499) with a{' '}
          <strong>30-min strategist call</strong>, a per-vertical NAP
          audit, a competitor heatmap, a{' '}
          <strong>90-day implementation roadmap</strong>, a 30-day
          re-scan, and a 60-day check-in.
          <br />
          <br />
          The <strong>$302 discount</strong>{' '}is locked to the next{' '}
          <strong>{safeHours} hours</strong>. After that, it&rsquo;s{' '}
          $499 from scratch — no recovery, no second chance.
          <br />
          <br />
          And it&rsquo;s underwritten by our{' '}
          <strong>TurfScore Lift Promise</strong>: implement the plan
          within 14 days. If you don&rsquo;t gain +10 TurfScore points
          in 90 days, we refund the full cost. Zero risk.
        </>
      ),
      cta: 'Upgrade now — save $302 →',
      footnote: (
        <>
          The $302 discount expires {safeHours} hours from now. After
          that, the audit lists at $499.
        </>
      ),
    };
  }

  if (stage === 'touch_2') {
    return {
      preview: `${safeHours} hours left to save $302 on your audit`,
      headline: `${safeHours} hours left.`,
      body: (
        <>
          Your <strong>$302 discount</strong>{' '}on the Visibility Audit
          upgrade expires in <strong>{safeHours} hours</strong>.
          {scoreText ? (
            <>
              {' '}
              You&rsquo;re sitting at{' '}
              <strong>{scoreText}/100</strong>{' '}right now. The audit
              upgrade ships a 90-day roadmap built specifically to lift
              that number.
            </>
          ) : (
            <>
              {' '}
              The audit upgrade ships a 90-day roadmap built specifically
              for {bizLabel}.
            </>
          )}
          <br />
          <br />
          And the <strong>TurfScore Lift Promise</strong>{' '}is the safety
          net: implement the plan in 14 days,{' '}
          <strong>
            +10 TurfScore points in 90 days or we refund the full cost
          </strong>
          . You can&rsquo;t lose.
          <br />
          <br />
          After the window closes, the upgrade lists at{' '}
          <strong>$499</strong>{' '}with no second chance at the {' '}
          $302 off.
        </>
      ),
      cta: `Upgrade now — ${safeHours}h left →`,
      footnote: (
        <>
          One-time charge of $197 ({" "}
          <span style={{ textDecoration: 'line-through' }}>$499</span>
          ). Refund guarantee. Cancel a charge isn&rsquo;t needed —
          there&rsquo;s no subscription.
        </>
      ),
    };
  }

  // touch_3 — final, 2-hour urgency
  return {
    preview: `Final ${safeHours}h: $302 audit discount expires soon`,
    headline: `Final ${safeHours} hours.`,
    body: (
      <>
        Your <strong>$302 discount</strong>{' '}on the Visibility Audit
        upgrade expires in <strong>{safeHours} hours</strong>
        {cutoffTimeLabel ? (
          <>
            {' '}
            (at <strong>{cutoffTimeLabel}</strong>)
          </>
        ) : null}
        .
        <br />
        <br />
        After that: <strong>$499</strong>, no second chance, no
        recovery code. The audit is the same either way — the{' '}
        30-min strategist call, the per-vertical NAP audit, the 90-day
        roadmap, the re-scan, the check-in, the{' '}
        <strong>+10 TurfScore points or full refund</strong>{' '}promise.
        Only the price changes.
        <br />
        <br />
        This is the last reminder I&rsquo;ll send about this. If the
        timing&rsquo;s wrong, just hit reply — I read every response.
      </>
    ),
    cta: 'Upgrade now — save $302 →',
    footnote: (
      <>— Anthony, TurfMap. Reply anytime; a real person sees it.</>
    ),
  };
}

export function AuditUpgradeRecoveryEmail({
  businessName,
  turfScore,
  reopenUrl,
  stage,
  hoursRemaining,
  cutoffTimeLabel,
}: AuditUpgradeRecoveryEmailProps) {
  const copy = copyForStage(
    stage,
    businessName ?? null,
    turfScore ?? null,
    hoursRemaining,
    cutoffTimeLabel ?? null
  );
  return (
    <EmailLayout preview={copy.preview}>
      <H1>{copy.headline}</H1>
      <P>{copy.body}</P>
      <PrimaryButton href={reopenUrl}>{copy.cta}</PrimaryButton>
      <PSmall>{copy.footnote}</PSmall>
    </EmailLayout>
  );
}
