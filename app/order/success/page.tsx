import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, AlertCircle, Check } from 'lucide-react';
import { OrderSuccessForm } from './OrderSuccessForm';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { getServerSupabase } from '@/lib/supabase/server';
import { loadCheckoutSession } from '@/lib/stripe/session';
import { getStripe } from '@/lib/stripe/client';
import {
  ensureLeadOrder,
  keywordCountForTier,
} from '@/lib/stripe/leadOrders';
import type { ClientRow, OnboardingStep, Tier } from '@/lib/supabase/types';

export const metadata: Metadata = {
  title: 'Order received — TurfMap™',
  description: "We've got your order. One more step before we fire your scan.",
  robots: { index: false, follow: false },
};

/**
 * Post-Stripe-checkout landing page.
 *
 * Stripe redirects buyers here after successful payment with
 * `tier=<scan|audit|strategy|pulse|pulse_plus>&session_id=cs_xxx` in
 * the query string. The page validates the session server-side,
 * idempotently records the order in `lead_orders`, and renders the
 * business-details form with the buyer's email pre-filled from
 * Stripe. The form's submit then hits /api/orders/fulfill which
 * creates the client row and fires the scan.
 *
 * Pre-Stripe-launch: if STRIPE_SECRET_KEY isn't configured the page
 * still renders the form so manual / development testing works —
 * just without email prefill or idempotent lead_orders tracking. The
 * fulfill API will surface its own clear error in that case.
 *
 * No auth required: the Stripe session id is the proof-of-purchase
 * gating downstream actions.
 */
export default async function OrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{
    tier?: string;
    session_id?: string;
    attach?: string;
    /** Set to 'audit' when the buyer just completed the $197 audit-
     *  upgrade Checkout (success_url stamps this). Used to override
     *  the default audit-tier copy ("$499 order is confirmed") with
     *  upgrade-specific copy ("$197 upgrade is confirmed — your $49
     *  scan already counted"). When absent, falls back to default
     *  tier-label copy. */
    upgrade?: string;
  }>;
}) {
  const {
    tier: tierParam,
    session_id: sessionId,
    attach: attachParam,
    upgrade: upgradeParam,
  } = await searchParams;
  const isAuditUpgrade = upgradeParam === 'audit';

  // ─── Stripe session validation + lead_orders idempotent insert ──────
  // Pulled into a helper so the rest of the render logic doesn't
  // become a tangle of conditionals. Returns the tier (which is
  // sourced from Stripe metadata, not the query param — query is a
  // hint) plus a pre-fillable email plus a "session not validated"
  // warning when applicable.
  const sessionState = sessionId
    ? await validateAndRecordSession(sessionId)
    : null;

  // Tier resolution precedence:
  //   1. Stripe-validated tier (canonical, can't be spoofed)
  //   2. Query param (fallback when Stripe lookup is unavailable)
  //   3. null  → render a "hmm, where'd you come from?" state
  const tier: Tier | null =
    sessionState?.kind === 'ok'
      ? sessionState.tier
      : isTierString(tierParam)
        ? tierParam
        : null;

  // Audit upgrade gets its own label — buyer paid $197 net (not the
  // $499 list), and framing it as "Audit Upgrade" makes the
  // distinction from a from-scratch $499 audit purchase clear.
  //
  // For other tiers, show the ACTUAL paid amount (post-discount)
  // when Stripe surfaced it. Falls back to the list-price label
  // when amount_total is missing. This matters most for /yourmap +
  // /fourdots buyers who paid $49 (MAPCHECK50 / FOURDOTS50) but
  // would otherwise see "$99" in the header.
  const paidAmountCents =
    sessionState?.kind === 'ok' ? sessionState.amountTotalCents : null;
  // Warm-cohort detection drives both label override and the
  // suppression rules forwarded to OrderSuccessForm.
  const cohortFromSession =
    sessionState?.kind === 'ok' ? sessionState.cohort : null;
  const isWarmCohort = cohortFromSession === 'crm_reactivation_q2';
  const tierLabel = isAuditUpgrade
    ? 'Visibility Audit upgrade ($197)'
    : isWarmCohort && tier === 'scan'
      ? // VIP warm cohort received the scan as a gift — frame it as
        // "free TurfScan", not "TurfScan ($0)" which is awkward and
        // commercial-sounding for the relational handoff.
        'free TurfScan'
      : tier
        ? paidAmountCents != null
          ? formatTierLabelWithPaidAmount(tier, paidAmountCents)
          : formatTierLabel(tier)
        : 'TurfMap';
  const keywordCount = tier ? keywordCountForTier(tier) : 1;
  const prefillEmail =
    sessionState?.kind === 'ok' ? sessionState.email : null;
  const sessionWarning =
    sessionState?.kind === 'warning' ? sessionState.message : null;
  const stripeCustomerId =
    sessionState?.kind === 'ok' ? sessionState.customerId : null;

  // ─── Saved-card lookup for 1-click audit upgrade ────────────────────
  // When the buyer has a Stripe Customer with a saved card (enabled
  // by payment_intent_data.setup_future_usage='off_session' on the
  // scan checkout), the AuditUpgradePanel can fire a no-redirect
  // PaymentIntent confirm. We surface the card's brand + last4
  // server-side so the panel can render "Confirm $197 charge to
  // Visa ending 4242" without an extra round-trip.
  //
  // Only runs for scan-tier orders that haven't already been
  // upgraded. Failure is graceful — falls through to redirect-style
  // Stripe Checkout upgrade. Don't fire on the upgrade-return path
  // (?upgrade=audit) since we don't need to surface the upgrade
  // panel anymore.
  let savedCard: { brand: string; last4: string } | null = null;
  if (
    tier === 'scan' &&
    stripeCustomerId &&
    !isAuditUpgrade &&
    !attachParam
  ) {
    try {
      const stripe = await getStripe();
      if (stripe) {
        const pmList = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: 'card',
          limit: 1,
        });
        const card = pmList.data[0]?.card;
        if (card) {
          savedCard = {
            brand: card.brand ?? 'card',
            last4: card.last4 ?? '',
          };
        }
      }
    } catch (e) {
      // Non-fatal: panel renders without saved-card UI, buyer
      // gets the redirect-style upgrade.
      console.error(
        '[order/success] saved-card lookup failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // Pulse-attach return path. When the buyer comes back from Stripe
  // with ?attach=success or ?attach=cancelled, we need to skip the
  // form re-render — they already filled it on the original purchase
  // — and surface the attach confirmation/cancellation state. Look
  // up the existing client by stripe_customer_id so we can pass the
  // public_id down to the form, which uses it to render the success
  // card directly (no second form pass).
  const attachState =
    attachParam === 'success'
      ? ('success' as const)
      : attachParam === 'cancelled'
        ? ('cancelled' as const)
        : null;
  let attachPublicId: string | null = null;
  let attachOnboardingStep: OnboardingStep | null = null;
  if (attachState && stripeCustomerId) {
    const supabase = getServerSupabase();
    const { data: client } = await supabase
      .from('clients')
      .select('id, public_id, onboarding_step')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle<
        Pick<ClientRow, 'id' | 'public_id' | 'onboarding_step'>
      >();
    attachPublicId = client?.public_id ?? null;
    attachOnboardingStep = client?.onboarding_step ?? null;

    // Defensive set: when attach succeeded but the webhook hasn't
    // fired yet (Stripe is at-least-once but eventual), the row may
    // still have onboarding_step=null even though the trial is live.
    // We stamp 'gbp_match' here so the wizard mounts immediately on
    // the buyer's first return-from-Stripe load — they shouldn't
    // wait for webhook ordering to start setup. Only acts on
    // attach=success (skipped on cancelled), only when client_id is
    // resolvable, and only when onboarding_step is null (so we never
    // rewind a buyer who's already past gbp_match).
    if (
      attachState === 'success' &&
      client &&
      client.onboarding_step === null
    ) {
      const { error: stepErr } = await supabase
        .from('clients')
        .update({ onboarding_step: 'gbp_match' as const })
        .eq('id', client.id)
        .is('onboarding_step', null);
      if (stepErr) {
        console.warn(
          '[order-success] failed to defensively set onboarding_step:',
          stepErr.message
        );
      } else {
        attachOnboardingStep = 'gbp_match';
      }
    }
  }

  return (
    <div className="min-h-screen w-full text-white flex flex-col">
      <header
        className="border-b px-6 md:px-12 py-5"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={14} />
            Back to TurfMap
          </Link>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono">
            Order confirmation
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 md:px-12 py-12 md:py-16">
        <div className="max-w-3xl mx-auto">
          <div
            className="border rounded-lg p-6 md:p-8 mb-8"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: 'var(--color-lime)',
                  boxShadow: '0 0 24px #c5ff3a40',
                }}
              >
                <Check size={20} className="text-black" strokeWidth={3} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
                  Payment received
                </div>
                <h1 className="font-display text-2xl md:text-3xl font-bold mb-2">
                  Thanks — your {tierLabel} order is confirmed.
                </h1>
                <p className="text-zinc-300 leading-relaxed">
                  {isAuditUpgrade
                    ? // Audit upgrade return path: scan is paid, audit is
                      // paid, intake still needed.
                      "Both the scan and the 90-day Roadmap audit are locked in. Fill out your business details below to kick everything off — we'll email your TurfMap as soon as your scan completes."
                    : isWarmCohort && tier === 'scan'
                      ? // VIP warm cohort: gift-delivery framing. No
                        // commercial follow-up here (no upsell panel —
                        // suppressed in OrderSuccessForm). Anthony-as-
                        // human framing positions the next conversation
                        // as relational, not transactional.
                        "We're running your 81-point geo-grid scan. Check your inbox in under a minute. Anthony will follow up after you've had a chance to look at your map."
                      : tier === 'scan'
                        ? // Cold-email / paid scan tier: the body
                          // component decides whether to render the
                          // AuditUpgradePanel (pre-Skip) or the intake
                          // form (post-Skip / post-upgrade). Header copy
                          // stays neutral so it works in both states.
                          "Your TurfScan is locked in. Complete the next steps below to fire your scan."
                        : // Audit / Strategy / other tiers that go
                          // straight to intake (no upgrade panel above).
                          <>
                            One more step. Tell us about your business —
                            your scan kicks off the moment you submit,
                            and we&rsquo;ll email your TurfMap as soon as
                            it&rsquo;s ready (typically under a minute).
                          </>}
                </p>
              </div>
            </div>
          </div>

          {sessionWarning && (
            <div
              className="border rounded-md px-4 py-3 mb-6 flex items-start gap-2.5 text-xs"
              style={{
                background: '#1a1308',
                borderColor: '#3a2a0a',
                color: '#f5b651',
              }}
            >
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span className="leading-relaxed">{sessionWarning}</span>
            </div>
          )}

          <Suspense
            fallback={
              <div className="text-sm text-zinc-500 font-mono">
                Loading order details…
              </div>
            }
          >
            <OrderSuccessForm
              tier={tier}
              sessionId={sessionId ?? null}
              keywordCount={keywordCount}
              prefillEmail={prefillEmail}
              stripeCustomerId={stripeCustomerId}
              attachState={attachState}
              attachPublicId={attachPublicId}
              attachOnboardingStep={attachOnboardingStep}
              isAuditUpgrade={isAuditUpgrade}
              savedCard={savedCard}
              prospectId={
                sessionState?.kind === 'ok' ? sessionState.prospectId : null
              }
              cohort={
                sessionState?.kind === 'ok' ? sessionState.cohort : null
              }
            />
          </Suspense>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

const TIER_LABELS: Record<Tier, string> = {
  scan: 'TurfScan ($99)',
  audit: 'Visibility Audit ($499)',
  strategy: 'Strategy Session ($1,497)',
  pulse: 'TurfMap Pulse ($39/mo)',
  pulse_plus: 'TurfMap Pulse+ ($89/mo)',
};

function formatTierLabel(tier: Tier): string {
  return TIER_LABELS[tier];
}

/** Same as formatTierLabel but substitutes the actual paid amount
 *  (post-discount) for the list price. E.g. MAPCHECK50 buyers paid
 *  \$49 not \$99; we want the header to reflect that, not the bare
 *  list price. Subscription tiers (pulse / pulse_plus) keep their
 *  recurring-price label since amount_total is the first-period
 *  charge which can be confusing in isolation. */
function formatTierLabelWithPaidAmount(tier: Tier, paidCents: number): string {
  if (tier === 'pulse' || tier === 'pulse_plus') {
    return TIER_LABELS[tier];
  }
  const dollars = Math.round(paidCents / 100);
  const name =
    tier === 'scan'
      ? 'TurfScan'
      : tier === 'audit'
        ? 'Visibility Audit'
        : tier === 'strategy'
          ? 'Strategy Session'
          : TIER_LABELS[tier];
  return `${name} ($${dollars})`;
}

function isTierString(v: string | undefined): v is Tier {
  return (
    v === 'scan' ||
    v === 'audit' ||
    v === 'strategy' ||
    v === 'pulse' ||
    v === 'pulse_plus'
  );
}

type SessionState =
  | {
      kind: 'ok';
      tier: Tier;
      email: string | null;
      /** Stripe Customer id captured during the original one-time
       *  checkout (customer_creation: 'if_required'). Forwarded to
       *  the OrderSuccessForm so it can wire the Pulse-attach panel
       *  to the same Stripe customer record. */
      customerId: string | null;
      /** Net amount paid in cents (after promotion-code discounts).
       *  Used in the page header to show what the buyer actually
       *  paid, e.g. \$49 with MAPCHECK50 vs. the \$99 list price.
       *  Null when Stripe didn't surface amount_total. */
      amountTotalCents: number | null;
      /** Warm-cohort prospect id captured at /yourmap or /freescan
       *  checkout time. Forwarded to the OrderSuccessForm so it can
       *  POST /api/prospect/[id]/engaged on the post-fulfillment view
       *  — the trigger for the Stage 2 audit-upgrade email cron. NULL
       *  when the buyer didn't come from a cohort lander. */
      prospectId: string | null;
      /** Cohort discriminator. 'crm_reactivation_q2' = warm cohort
       *  (VIP coupon, /freescan) — suppresses the audit upsell + Pulse
       *  attach panels per campaign brief's MUST-NOT-render rules.
       *  'cold_email' = paid cold-email cohort (MAPCHECK50, /yourmap)
       *  — standard upsell flow. NULL = organic / popup buyer. */
      cohort: string | null;
    }
  | { kind: 'warning'; message: string };

/**
 * Stripe session lookup + lead_orders idempotent insert. Returns:
 *   - { kind: 'ok' }      session validated, lead_orders row exists
 *   - { kind: 'warning' } stripe lookup didn't yield a usable session,
 *                         or stripe isn't configured. The page still
 *                         renders the form (operators may be testing
 *                         locally without stripe wired), but with an
 *                         amber warning banner explaining what's off.
 *
 * Never throws — every error path produces a 'warning' so the page
 * always renders.
 */
async function validateAndRecordSession(
  sessionId: string
): Promise<SessionState> {
  const result = await loadCheckoutSession(sessionId);

  if ('kind' in result) {
    switch (result.kind) {
      case 'stripe_not_configured':
        return {
          kind: 'warning',
          message:
            'Stripe is not yet configured for this environment. Order details are not being recorded automatically — submit the form and we will fulfill manually.',
        };
      case 'session_not_found':
        return {
          kind: 'warning',
          message:
            "We couldn't locate your Stripe session. If you completed payment, email support@turfmap.ai with your receipt and we'll fulfill manually.",
        };
      case 'payment_not_complete':
        return {
          kind: 'warning',
          message: `Stripe shows your payment status as "${result.paymentStatus ?? 'unknown'}". If you completed payment, refresh in a few seconds — Stripe sometimes lags.`,
        };
      case 'invalid_tier':
        return {
          kind: 'warning',
          message:
            "Your Stripe session doesn't have a recognized tier. Email support@turfmap.ai with your session id.",
        };
      case 'stripe_error':
        return {
          kind: 'warning',
          message: `Stripe lookup hit an error: ${result.message}. Submit the form anyway and we will reconcile manually.`,
        };
    }
  }

  // Session is valid — write/refresh the lead_orders row idempotently.
  // Failure here is non-fatal: log it, but render the page so the
  // buyer can still complete the form.
  const supabase = getServerSupabase();
  await ensureLeadOrder(supabase, result);

  return {
    kind: 'ok',
    tier: result.tier,
    email: result.customerEmail,
    customerId: result.customerId,
    amountTotalCents: result.amountTotal,
    prospectId: result.prospectId,
    cohort: result.cohort,
  };
}
