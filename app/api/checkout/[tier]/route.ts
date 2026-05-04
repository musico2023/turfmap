import { NextRequest, NextResponse } from 'next/server';

/**
 * Stripe Checkout session bootstrapper.
 *
 * POST /api/checkout/<tier>  — where tier is 'scan' | 'audit' | 'strategy'.
 * Returns { url } pointing at the hosted Stripe Checkout page. Client
 * redirects the browser there.
 *
 * This route is *intentionally* defensive about missing env vars: when
 * STRIPE_SECRET_KEY or the per-tier price-id is unset (the expected
 * pre-launch state), it returns 503 with a human-readable error so the
 * pricing card can render an inline "checkout not yet wired" message
 * rather than silently failing or 500-ing the user.
 *
 * Required env (set in Vercel + .env.local before launch):
 *   STRIPE_SECRET_KEY                       — server-side, secret
 *   NEXT_PUBLIC_STRIPE_PRICE_SCAN           — price_xxx for $99
 *   NEXT_PUBLIC_STRIPE_PRICE_AUDIT          — price_xxx for $499
 *   NEXT_PUBLIC_STRIPE_PRICE_STRATEGY       — price_xxx for $1,497
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

const TIER_TO_ENV: Record<Tier, string> = {
  scan: 'NEXT_PUBLIC_STRIPE_PRICE_SCAN',
  audit: 'NEXT_PUBLIC_STRIPE_PRICE_AUDIT',
  strategy: 'NEXT_PUBLIC_STRIPE_PRICE_STRATEGY',
  pulse: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY',
  pulse_plus: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_PLUS_MONTHLY',
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

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceEnvKey = TIER_TO_ENV[tierParam];
  const priceId = process.env[priceEnvKey];

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
        error: `Checkout not yet configured for "${tierParam}". Set ${priceEnvKey}.`,
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
