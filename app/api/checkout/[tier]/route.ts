import { NextRequest, NextResponse } from 'next/server';

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
 * The high-level pattern (to be wired alongside the live Stripe products
 * — not enabled by this commit because the price IDs don't exist yet):
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
 * The conversion-to-schedule happens in the order-fulfill route (or in
 * a Stripe webhook handler on `customer.subscription.created`) once the
 * Pulse+ monthly checkout completes — not in this checkout-bootstrapper
 * route. This route just opens the checkout session.
 *
 * Success URL: /order/success?tier=<tier>&session_id={CHECKOUT_SESSION_ID}
 *   — the trailing template variable is interpolated by Stripe at
 *     redirect time; the order-success page reads it to fetch the
 *     line-item / customer email and pre-fills the scan-trigger form.
 *
 * Cancel URL: /#section-05  — deposits the user back on the pricing
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

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';

  const isSubscription = SUBSCRIPTION_TIERS.has(tierParam);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: isSubscription ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/order/success?tier=${tierParam}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#section-05`,
      // Capture the buyer's email up-front so the post-purchase form
      // can pre-fill it. allow_promotion_codes lets us run launch
      // discounts without rebuilding.
      // customer_creation isn't valid in subscription mode (Stripe
      // always creates a customer for subs), so only set it for
      // one-time payments.
      ...(isSubscription ? {} : { customer_creation: 'if_required' as const }),
      allow_promotion_codes: true,
      metadata: {
        tier: tierParam,
        // Stamp cadence on subscription sessions so the
        // order-fulfill pipeline + Stripe webhook can tell monthly
        // from annual without re-querying the Price object.
        ...(isSubscription ? { cadence } : {}),
      },
    });

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
