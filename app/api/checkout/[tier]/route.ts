import { NextRequest, NextResponse } from 'next/server';
import { appOrigin } from '@/lib/urls';

/**
 * Stripe Checkout session bootstrapper.
 *
 * POST /api/checkout/<tier>  — where tier is 'scan' | 'audit' | 'strategy'
 *   | 'pulse' | 'pulse_plus'. Returns { url } pointing at the hosted
 * Stripe Checkout page; client redirects the browser there.
 *
 * This route is *intentionally* defensive about missing env vars: when
 * STRIPE_SECRET_KEY or the per-tier price-id is unset (the expected
 * pre-launch state), it returns 503 with a human-readable error so the
 * pricing card can render an inline "checkout not yet wired" message
 * rather than silently failing or 500-ing the user.
 *
 * Required env (set in Vercel + .env.local before launch):
 *   STRIPE_SECRET_KEY                              — server-side, secret
 *   NEXT_PUBLIC_STRIPE_PRICE_SCAN                  — price_xxx for $99
 *   NEXT_PUBLIC_STRIPE_PRICE_AUDIT                 — price_xxx for $499
 *   NEXT_PUBLIC_STRIPE_PRICE_STRATEGY              — price_xxx for $1,497
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY         — price_xxx for $39/mo
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSE_ANNUAL          — price_xxx for $372/year (wiring TBD)
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY     — price_xxx for $99/mo
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL      — price_xxx for $950/year (wiring TBD)
 *
 * ─── Pulse+ 3-month minimum (Subscription Schedules) ──────────────────
 * Pulse+ on monthly billing requires a 3-month minimum commitment. The
 * Stripe-native primitive for this is Subscription Schedules:
 * https://docs.stripe.com/billing/subscriptions/subscription-schedules
 *
 * The wrap runs in the customer.subscription.{created,updated}
 * webhook handler via `ensurePulsePlusCommitmentSchedule`
 * (lib/stripe/subscription.ts):
 *
 *   1. The Pulse+ monthly Price ($99/mo, env above) stays as a normal
 *      recurring Price object in Stripe.
 *   2. When the buyer completes Stripe Checkout in `mode: subscription`,
 *      Stripe creates a Subscription. We immediately convert it into a
 *      two-phase Subscription Schedule:
 *        Phase 1 — 3 iterations (months) at the Pulse+ monthly Price.
 *                  Buyer is contractually obligated for all 3 months;
 *                  cancellation requested in months 1-2 still bills
 *                  through end of phase 1.
 *        Phase 2 — month-to-month at the same Price, normal
 *                  cancel_at_period_end behavior thereafter.
 *      Reference flow:
 *        const sub = await stripe.subscriptions.retrieve(<sub_id>);
 *        await stripe.subscriptionSchedules.create({
 *          from_subscription: sub.id,
 *        });
 *        // then update the schedule with the two-phase plan.
 *   3. The Pulse+ annual price ($950/year) does NOT need a schedule —
 *      a 12-month subscription already implicitly commits the buyer.
 *      Standard cancel_at_period_end applies.
 *
 * Cancel UX in the agency dashboard:
 *   - Phase 1 (months 1-3): "Your minimum commitment ends <date>.
 *     Cancellation takes effect on that date." Disable immediate-cancel.
 *   - Phase 2 (month 4+): standard cancel-at-period-end flow.
 *
 * The Schedule is created from the customer.subscription.created
 * webhook (not from this checkout-bootstrapper route). Idempotent
 * via the wrap helper's `skipped_already_scheduled` short-circuit
 * — re-firing on `customer.subscription.updated` no-ops.
 *
 * Success URL: /order/success?tier=<tier>&session_id={CHECKOUT_SESSION_ID}
 *   — the trailing template variable is interpolated by Stripe at
 *     redirect time; the order-success page reads it to fetch the
 *     line-item / customer email and pre-fills the scan-trigger form.
 *
 * Cancel URL: /#section-04  — deposits the user back on the pricing
 *   section so they don't lose their place.
 */

type Tier = 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';

type Cadence = 'monthly' | 'annual';

/** One-time tiers map to a single env var (no cadence dimension).
 *  Subscription tiers map to a (tier, cadence) pair. */
const ONE_TIME_TIER_TO_ENV: Record<
  'scan' | 'audit' | 'strategy',
  string
> = {
  scan: 'NEXT_PUBLIC_STRIPE_PRICE_SCAN',
  audit: 'NEXT_PUBLIC_STRIPE_PRICE_AUDIT',
  strategy: 'NEXT_PUBLIC_STRIPE_PRICE_STRATEGY',
};

const SUBSCRIPTION_TIER_TO_ENV: Record<
  'pulse' | 'pulse_plus',
  Record<Cadence, string>
> = {
  pulse: {
    monthly: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY',
    annual: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_ANNUAL',
  },
  pulse_plus: {
    monthly: 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY',
    annual: 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL',
  },
};

/** One-time tiers use Stripe `mode: 'payment'`; recurring tiers use
 *  `mode: 'subscription'`. The Stripe Price ID points at a recurring
 *  product for Pulse/Pulse+ on the dashboard side. */
const SUBSCRIPTION_TIERS: ReadonlySet<Tier> = new Set(['pulse', 'pulse_plus']);

function isTier(s: string): s is Tier {
  return (
    s === 'scan' ||
    s === 'audit' ||
    s === 'strategy' ||
    s === 'pulse' ||
    s === 'pulse_plus'
  );
}

function isCadence(s: string | null): s is Cadence {
  return s === 'monthly' || s === 'annual';
}

/** True when the coupon code is one we know zeroes the line item out
 *  (100% off). Used to gate setup_future_usage off — at $0 Stripe
 *  Checkout would otherwise force card collection to register the
 *  payment method, defeating the frictionless-free goal. List is
 *  intentionally explicit (not a generic discount lookup) so a
 *  legitimate near-100%-off coupon can't accidentally trigger the
 *  free-checkout path. */
function isHundredPercentOffCoupon(couponCode: string): boolean {
  const HUNDRED_PERCENT_OFF = new Set(['VIP']);
  return HUNDRED_PERCENT_OFF.has(couponCode.toUpperCase());
}

/** Resolves the env var key + price for the (tier, cadence) tuple.
 *  Returns null on a malformed combination (e.g. cadence on a
 *  one-time tier — currently rejected; future could allow). */
function resolvePriceEnv(
  tier: Tier,
  cadence: Cadence
): { envKey: string; priceId: string | undefined } | null {
  if (tier === 'scan' || tier === 'audit' || tier === 'strategy') {
    const envKey = ONE_TIME_TIER_TO_ENV[tier];
    return { envKey, priceId: process.env[envKey] };
  }
  const envKey = SUBSCRIPTION_TIER_TO_ENV[tier][cadence];
  return { envKey, priceId: process.env[envKey] };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tier: string }> }
) {
  const { tier: tierParam } = await ctx.params;
  if (!isTier(tierParam)) {
    return NextResponse.json(
      { error: `unknown tier "${tierParam}"` },
      { status: 400 }
    );
  }

  // Cadence is read from a query param (POST URL is short, no body
  // needed for one-time tiers). Defaults to 'monthly' for
  // subscription tiers when unspecified — preserves back-compat with
  // marketing CTAs that haven't yet adopted the toggle. One-time
  // tiers ignore the param.
  const url = new URL(req.url);
  const cadenceParam = url.searchParams.get('cadence');
  const cadence: Cadence = isCadence(cadenceParam) ? cadenceParam : 'monthly';

  // Coupon + attribution params. The /fourdots lander forwards these from
  // the popup URL so the buyer never has to manually paste a code on
  // the Stripe checkout page, and so we can attribute the conversion
  // back to the source campaign in Stripe + GA4.
  const couponParam = (url.searchParams.get('coupon') ?? '').trim();
  const utmSource = url.searchParams.get('utm_source') ?? '';
  const utmMedium = url.searchParams.get('utm_medium') ?? '';
  const utmCampaign = url.searchParams.get('utm_campaign') ?? '';
  const gclid = url.searchParams.get('gclid') ?? '';
  const clientReferenceId = url.searchParams.get('client_reference_id') ?? '';
  // Cold-email cohort attribution. /yourmap forwards this so the
  // fulfill route can stamp prospects.converted_at when the buyer
  // completes payment + the funnel dashboard can join conversions
  // back to the originating outreach record.
  const prospectId = url.searchParams.get('prospect_id') ?? '';

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const resolved = resolvePriceEnv(tierParam, cadence);
  if (!resolved) {
    return NextResponse.json(
      { error: `unable to resolve price for "${tierParam}" / "${cadence}"` },
      { status: 400 }
    );
  }
  const { envKey: priceEnvKey, priceId } = resolved;

  if (!secretKey) {
    return NextResponse.json(
      {
        error:
          'Checkout not yet configured. Set STRIPE_SECRET_KEY in your environment.',
      },
      { status: 503 }
    );
  }
  if (!priceId) {
    return NextResponse.json(
      {
        error: `Checkout not yet configured for "${tierParam}" (${cadence}). Set ${priceEnvKey}.`,
      },
      { status: 503 }
    );
  }

  // Lazy import — keeps the `stripe` SDK out of the bundle for build
  // environments that don't have it installed yet. Safe because we
  // only reach here when STRIPE_SECRET_KEY is present, which implies
  // the deps were installed.
  let Stripe: typeof import('stripe').default;
  try {
    Stripe = (await import('stripe')).default;
  } catch {
    return NextResponse.json(
      {
        error:
          'Stripe SDK not installed. Run `npm i stripe` and redeploy.',
      },
      { status: 503 }
    );
  }

  const stripe = new Stripe(secretKey);

  const origin = appOrigin();

  const isSubscription = SUBSCRIPTION_TIERS.has(tierParam);

  // Resolve the coupon code (if any) to a Stripe `discounts` array.
  // Stripe accepts EITHER a Promotion Code id (`promo_xxx`) or a
  // Coupon id — but the URL gives us the customer-facing string,
  // which for Promotion Codes needs a server-side lookup to convert
  // to the id. Strategy: try Promotion Code lookup first (the more
  // common case for landing-page codes); fall back to treating the
  // raw string as a Coupon id if no active Promotion Code matches.
  // If neither resolves, drop the discount silently — checkout will
  // proceed at full price + the buyer can still paste the code into
  // Stripe's promo-code field (allow_promotion_codes stays on as a
  // safety net).
  let discounts: Array<
    { promotion_code: string } | { coupon: string }
  > | undefined = undefined;
  if (couponParam) {
    try {
      const promos = await stripe.promotionCodes.list({
        code: couponParam,
        active: true,
        limit: 1,
      });
      if (promos.data[0]?.id) {
        discounts = [{ promotion_code: promos.data[0].id }];
      } else {
        // No active promotion code with this string — try as a raw
        // Coupon id. Stripe will throw on session create if neither
        // works; the catch below falls back to no-discount checkout.
        discounts = [{ coupon: couponParam }];
      }
    } catch {
      // Promotion-code lookup failed (network, rate limit, etc.);
      // fall back to raw Coupon id below. We still want checkout to
      // proceed even if the discount can't be auto-applied.
      discounts = [{ coupon: couponParam }];
    }
  }

  // Stripe metadata is a flat string-string map. We collapse the
  // attribution params onto it so they're queryable from the
  // dashboard + present on the checkout.session.completed webhook
  // payload — that's where the real conversion-tracking lives. Empty
  // values are dropped so the metadata stays lean.
  const attribution: Record<string, string> = {};
  if (utmSource) attribution.utm_source = utmSource;
  if (utmMedium) attribution.utm_medium = utmMedium;
  if (utmCampaign) attribution.utm_campaign = utmCampaign;
  if (gclid) attribution.gclid = gclid;
  if (couponParam) attribution.coupon = couponParam;
  // Cold-email cohort marker — fulfill route reads this back from
  // the session metadata + stamps prospects.converted_at.
  if (prospectId) attribution.prospect_id = prospectId;
  // Cohort discriminator for cohort-level reporting (cold_email vs
  // crm_reactivation_q2). Derive from coupon code so the lander
  // doesn't need to pass it explicitly: VIP → crm_reactivation_q2,
  // otherwise default to cold_email (the original cohort). When new
  // cohorts launch, extend the map below or pass an explicit
  // ?cohort= URL param.
  const cohortFromCoupon: Record<string, string> = {
    VIP: 'crm_reactivation_q2',
  };
  const cohort =
    url.searchParams.get('cohort') ??
    cohortFromCoupon[couponParam.toUpperCase()] ??
    (prospectId ? 'cold_email' : undefined);
  if (cohort) attribution.cohort = cohort;

  // Mandatory $99 TurfScan setup fee on MONTHLY Pulse / Pulse+
  // signups (NOT annual).
  //
  // Rationale (2026-05-17 pricing decision): before this change, a
  // buyer could go directly from the marketing page → Stripe Checkout
  // for $39/mo (Pulse) or $99/mo (Pulse+) and receive the equivalent
  // of a $99 TurfScan as their first weekly scan — effectively
  // skipping the diagnostic charge entirely. Adding it as a required
  // one-time line item on monthly signups:
  //   - lifts year-1 revenue ~$99/buyer on Pulse monthly
  //   - lifts 3-month-commit net ~$99/buyer on Pulse+ monthly
  //     (40% → 54% margin)
  //   - keeps annual buyers exempt — they're effectively pre-paying
  //     the equivalent via the annual discount, framed on the
  //     homepage as "TurfScan ($99 value) included"
  //
  // Stripe natively supports mixed one-time + recurring line items
  // in a single `mode: 'subscription'` session: the first invoice
  // bills both, every subsequent invoice bills only the recurring
  // price. No special webhook plumbing required.
  //
  // The scan Price ID is the same one used for standalone TurfScan
  // checkouts (NEXT_PUBLIC_STRIPE_PRICE_SCAN). Reusing it keeps the
  // line-item description ("TurfScan") consistent across products
  // and lets the existing fulfillment pipeline run unchanged.
  const lineItems: Array<{ price: string; quantity: number }> = [
    { price: priceId, quantity: 1 },
  ];
  const requiresScanSetup =
    isSubscription &&
    (tierParam === 'pulse' || tierParam === 'pulse_plus') &&
    cadence === 'monthly';
  if (requiresScanSetup) {
    const scanPriceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_SCAN;
    if (!scanPriceId) {
      return NextResponse.json(
        {
          error:
            'Checkout misconfigured: NEXT_PUBLIC_STRIPE_PRICE_SCAN is required for monthly Pulse/Pulse+ checkouts (mandatory $99 setup line item).',
        },
        { status: 503 }
      );
    }
    lineItems.push({ price: scanPriceId, quantity: 1 });
  }

  // Build the session params. We try with the resolved discount
  // first; if Stripe rejects (invalid coupon, expired, tier-
  // mismatched), retry without it so the buyer doesn't get stuck.
  const baseParams: import('stripe').default.Checkout.SessionCreateParams = {
    mode: isSubscription ? 'subscription' : 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    success_url: `${origin}/order/success?tier=${tierParam}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/#section-04`,
    // Capture the buyer's email up-front so the post-purchase form
    // can pre-fill it.
    // customer_creation isn't valid in subscription mode (Stripe
    // always creates a customer for subs), so only set it for
    // one-time payments. We use 'always' (not the default
    // 'if_required') so EVERY one-time buyer gets a Stripe
    // customer record. This is what powers the audit-upgrade
    // mechanic on /order/success: the upgrade endpoint needs a
    // customer id to pre-bind the upgrade Checkout to the same
    // payment method. 'if_required' would only create a customer
    // when the buyer ticked "save payment method," which most
    // one-time buyers don't — so without this, the upgrade path
    // 400s for the majority of scan buyers.
    ...(isSubscription ? {} : { customer_creation: 'always' as const }),
    // For one-time tiers (excluding 100%-off / $0 checkouts):
    // attach the payment method to the customer record
    // (setup_future_usage: 'off_session') so the audit-upgrade
    // mechanic on /order/success can charge the saved card without
    // requiring the buyer to re-enter card details. The upgrade
    // Checkout (which already passes `customer: customerId`) will
    // surface the saved payment method, turning the upgrade into
    // effectively a 1-click confirm. Stripe handles the consent
    // disclosure microcopy automatically.
    //
    // SKIP setup_future_usage when the coupon is 100%-off (e.g.
    // VIP). Stripe Checkout would otherwise force card collection
    // on a $0 charge to register the payment method for future
    // off-session use — defeats the "frictionless free scan" goal
    // for the warm-cohort campaign. These buyers don't get the
    // 1-click upgrade path; they fall back to the redirect-style
    // upgrade Checkout (Stripe collects card fresh on the $197
    // upgrade), which already works correctly.
    ...(isSubscription || isHundredPercentOffCoupon(couponParam)
      ? {}
      : {
          payment_intent_data: {
            setup_future_usage: 'off_session' as const,
          },
        }),
    metadata: {
      tier: tierParam,
      // Stamp cadence on subscription sessions so the
      // order-fulfill pipeline + Stripe webhook can tell monthly
      // from annual without re-querying the Price object.
      ...(isSubscription ? { cadence } : {}),
      ...attribution,
    },
    ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
  };

  try {
    let session: import('stripe').default.Checkout.Session;
    try {
      // First attempt: with the resolved discount. allow_promotion_codes
      // is mutually exclusive with `discounts` on Stripe's side —
      // omitting it when we pre-apply a discount avoids the API error
      // "You may not specify both a coupon and the
      // allow_promotion_codes option."
      session = await stripe.checkout.sessions.create({
        ...baseParams,
        ...(discounts
          ? { discounts }
          : { allow_promotion_codes: true }),
      });
    } catch (e) {
      // Discount rejected (invalid / expired / tier-mismatched code) —
      // retry without it so the buyer reaches checkout. They can still
      // hand-enter a valid code via Stripe's promo-code input.
      if (discounts) {
        console.warn(
          '[checkout] discount rejected, retrying without:',
          e instanceof Error ? e.message : e
        );
        session = await stripe.checkout.sessions.create({
          ...baseParams,
          allow_promotion_codes: true,
        });
      } else {
        throw e;
      }
    }

    if (!session.url) {
      return NextResponse.json(
        { error: 'Stripe returned no redirect URL' },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown Stripe error';
    return NextResponse.json(
      { error: `Stripe checkout creation failed: ${message}` },
      { status: 502 }
    );
  }
}
