/**
 * ScoreUnlockNudgeEmail — 3-touch drip for /score lead-magnet
 * visitors who got their free TurfScore but haven't paid $99 to
 * unlock the full map + Fix List.
 *
 * Three escalating touches, fired off the single preview-init event:
 *
 *   touch_1 — immediately ("here's your score + preview link")
 *   touch_2 — +24h ("your competitors are named in the unlocked
 *              version — see who")
 *   touch_3 — +72h (final, soft scarcity + hit-reply offer)
 *
 * Touch 1 sends immediately from the preview-init route; touches 2
 * and 3 are queued via Resend scheduled-send. Same mechanism as
 * ScanRecoveryEmail (cart-abandonment) + AuditBookingNudgeEmail —
 * no sub-daily Vercel Cron, which Hobby tier can't run anyway. All
 * three are cancelled if the buyer unlocks (handleScoreUnlock reads
 * the scheduled email ids off lead_orders.stripe_metadata).
 *
 * Visual rhythm matches AuditBookingNudgeEmail + ScanRecoveryEmail
 * so the buyer's inbox feels consistent across the funnels.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';
import { isDiscountedLeadSource } from '@/lib/score/leadSources';

export type ScoreUnlockNudgeStage = 'touch_1' | 'touch_2' | 'touch_3';

export type ScoreUnlockNudgeEmailProps = {
  /** Business name the buyer entered on /score. Used to anchor the
   *  copy ("for Acme Plumbing"). Optional — the template stays
   *  graceful when missing (rare, but defensive). */
  businessName?: string | null;
  /** Primary keyword the buyer scanned for. Same optional treatment
   *  as ScanRecoveryEmail — drops the "for 'keyword'" fragment when
   *  not present rather than printing empty quotes. */
  keyword?: string | null;
  /** Their TurfScore (0–100). Used in touch 1's headline + touch 3's
   *  loss frame. Null when the scan partially failed (rare). */
  turfScore?: number | null;
  /** The band label ("Patchy", "Solid", etc.). Used in touch 1 to
   *  ground the score with a verbal anchor. Null when score is null. */
  turfBand?: string | null;
  /** /share/<id> URL to the preview. Same URL across all three
   *  touches — preview lives until the buyer unlocks or the 30-day
   *  GC cron sweeps. */
  previewUrl: string;
  /** Which touch this email represents. Drives every variable copy
   *  surface (preview / headline / body / CTA / footnote). */
  stage: ScoreUnlockNudgeStage;
  /** Lander identifier (e.g. 'free_score', 'prove_it', 'score'). When
   *  the slug qualifies for the Meta-cohort discount (see
   *  lib/score/leadSources.ts), the email renders "$49 with code
   *  MAPCHECK50" wherever the price is named, instead of the $99 list
   *  price. Keeps the email price in sync with what unlock-init will
   *  actually charge — otherwise the buyer sees "$99" in the inbox
   *  and "$49" when they click through, which torches trust + CTR. */
  leadSource?: string | null;
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
  stage: ScoreUnlockNudgeStage,
  businessName?: string | null,
  keyword?: string | null,
  turfScore?: number | null,
  turfBand?: string | null,
  leadSource?: string | null
): StageCopy {
  const biz = businessName?.trim() || null;
  const kw = keyword?.trim() || null;
  const bizLabel = biz ?? 'your business';
  const scoreText =
    typeof turfScore === 'number' && Number.isFinite(turfScore)
      ? String(Math.round(turfScore))
      : null;
  const bandText = turfBand?.trim() || null;

  // Discount-aware price strings. The Meta-cohort landers (free_score,
  // prove_it) get MAPCHECK50 auto-applied on /share unlock, so we
  // surface the discounted $49 here too. Homepage /score traffic +
  // unknown sources see the $99 list price.
  const discounted = isDiscountedLeadSource(leadSource);
  // Inline price for sentences ("…unlock for $49 with code MAPCHECK50.").
  const priceInline = discounted ? '$49 with code MAPCHECK50' : '$99';
  // CTA-button suffix ("Unlock the full map — $49 →").
  const priceCta = discounted ? '$49' : '$99';

  if (stage === 'touch_1') {
    return {
      preview: scoreText
        ? `Your TurfScore${biz ? ` for ${biz}` : ''} is ${scoreText}${bandText ? ` (${bandText})` : ''}`
        : `Your TurfScore${biz ? ` for ${biz}` : ''} is ready`,
      headline: scoreText
        ? `Your TurfScore is ${scoreText}.`
        : 'Your TurfScore is ready.',
      body: (
        <>
          The 81-point scan{forBusiness(biz)} just finished.
          {scoreText ? (
            <>
              {' '}
              You scored{' '}
              <strong>
                {scoreText}/100
                {bandText ? ` (${bandText})` : ''}
              </strong>
              {kw ? (
                <>
                  {' '}
                  for <strong>&lsquo;{kw}&rsquo;</strong>
                </>
              ) : null}
              .
            </>
          ) : null}{' '}
          Your map preview is live — open it to see where you appear
          and where you don&apos;t. The full cell-by-cell map,
          competitor breakdown, and AI Coach Fix List unlock for{' '}
          <strong>{priceInline}</strong>.
        </>
      ),
      cta: 'Open my TurfScore →',
      footnote: (
        <>
          Save this link — your preview stays live for 90 days so you
          can come back anytime. Unlock when you&rsquo;re ready.
        </>
      ),
    };
  }

  if (stage === 'touch_2') {
    return {
      preview: `Your competitors are on the unlocked map — ${bizLabel}`,
      headline: 'Your competitors are named in the full report.',
      body: (
        <>
          You saw{' '}
          {scoreText ? (
            <>
              <strong>
                {scoreText}/100
                {bandText ? ` (${bandText})` : ''}
              </strong>{' '}
            </>
          ) : (
            <>your TurfScore </>
          )}
          yesterday. The blurred map preview is suggestive — the
          unlocked version names every competitor taking calls in your
          weak zones, shows you exactly which neighborhoods are
          invisible, and ships a three-action Fix List written from
          your real audit data. None of it is generic SEO advice —
          it&rsquo;s all anchored to{' '}
          <strong>{bizLabel}</strong>.
        </>
      ),
      cta: `Unlock the full map — ${priceCta} →`,
      footnote: discounted ? (
        <>
          One-time charge, no subscription. Code{' '}
          <strong>MAPCHECK50</strong> auto-applied at checkout. Full
          refund within 7 days if the unlocked report doesn&rsquo;t
          show you something you didn&rsquo;t already know.
        </>
      ) : (
        <>
          One-time charge, no subscription. Full refund within 7 days
          if the unlocked report doesn&rsquo;t show you something you
          didn&rsquo;t already know.
        </>
      ),
    };
  }

  // touch_3 — final, soft scarcity + personal hit-reply offer.
  // No explicit price in the body (kept conversational), but the
  // discounted footnote nudges the MAPCHECK50 affordance one more
  // time for Meta-cohort buyers.
  return {
    preview: `Last reminder about your TurfScore — ${bizLabel}`,
    headline: 'Last reminder about your unlock.',
    body: (
      <>
        This is the last nudge about your TurfScore{forBusiness(biz)}.
        {scoreText ? (
          <>
            {' '}
            You&rsquo;re sitting at{' '}
            <strong>
              {scoreText}/100
              {bandText ? ` (${bandText})` : ''}
            </strong>{' '}
            — the unlock shows you exactly which cells to work on first
            and which competitors are eating the calls.
          </>
        ) : null}{' '}
        Your preview link stays live for now, but I&rsquo;d hate for
        you to leave money on the table because the map stayed locked.
        If something specific is in the way, just hit reply and tell me
        — I read every response.
      </>
    ),
    cta: 'Unlock my full map →',
    footnote: discounted ? (
      <>
        — Anthony, TurfMap. Your <strong>MAPCHECK50</strong> code is
        still good — unlock pulls down to $49 at checkout. Reply
        anytime, a real person sees it.
      </>
    ) : (
      <>— Anthony, TurfMap. Reply anytime — a real person sees it.</>
    ),
  };
}

export function ScoreUnlockNudgeEmail({
  businessName,
  keyword,
  turfScore,
  turfBand,
  previewUrl,
  stage,
  leadSource,
}: ScoreUnlockNudgeEmailProps) {
  const copy = copyForStage(
    stage,
    businessName,
    keyword,
    turfScore,
    turfBand,
    leadSource
  );
  return (
    <EmailLayout preview={copy.preview}>
      <H1>{copy.headline}</H1>
      <P>{copy.body}</P>
      <PrimaryButton href={previewUrl}>{copy.cta}</PrimaryButton>
      <PSmall>{copy.footnote}</PSmall>
    </EmailLayout>
  );
}
