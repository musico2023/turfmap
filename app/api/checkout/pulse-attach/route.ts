/**
 * POST /api/checkout/pulse-attach
 *
 * Post-purchase Pulse attach offer — turns a one-time TurfScan / Audit /
 * Strategy buyer into a Pulse subscriber via a 30-day card-on-file trial.
 *
 * The marketing-side framing is: "Track your map weekly. Free for 30
 * days. Cancel anytime before day 31 to pay nothing." The mechanic is
 * a Stripe Checkout session in `mode: 'subscription'` with
 * `trial_period_days: 30` against the existing Stripe customer. The
 * buyer hits Stripe to save a card, then comes back to /order/success
 * with `?attach=success` flagged.
 *
 * Why card-on-file required up front (vs day-29 email reminder):
 *   - Conversion to paid is ~3-5x higher when the card's already saved
 *     (the buyer's already in buying mode at attach time).
 *   - Stripe sends an automatic "trial ending soon" email 7 days
 *     before charge — no day-29 custom Resend template needed.
 *   - Cancel-anytime-before-day-31 is preserved (Stripe natively
 *     handles trial cancellation: cancel_at_period_end=true during
 *     trial = no charge, sub deleted at period end).
 *
 * Body:
 *   {
 *     publicId: string,         // existing client public_id from fulfill
 *     stripeCustomerId: string, // captured during the original one-time
 *                               // checkout (customer_creation:'if_required')
 *     originalSessionId: string // the cs_xxx of the original purchase, so
 *                               // we can deposit the buyer back on
 *                               // /order/success with their original
 *                               // session intact (so the success-page
 *                               // state still hydrates correctly)
 *   }
 *
 * Response:
 *   200 { url: string }   Stripe Checkout URL — client redirects here
 *   4xx { error: string }
 *
 * Webhook contract: when Stripe fires customer.subscription.created
 * with status='trialing', the existing /api/stripe/webhook handler
 * picks up subscription_data.metadata.client_id (set below), looks up
 * the existing client row, and writes tier='pulse',
 * subscription_status='trialing'. No new client row is created — we
 * upgrade the same row that the original TurfScan fulfillment created.
 *
 * Required env (set in Vercel + .env.local):
 *   STRIPE_SECRET_KEY
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY   — the Pulse $39/mo Price ID
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const BodySchema = z.object({
  publicId: z.string().min(1),
  stripeCustomerId: z.string().min(1).startsWith('cus_'),
  originalSessionId: z.string().min(1).startsWith('cs_'),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? `invalid body: ${e.issues.map((iss) => iss.message).join(', ')}`
            : 'invalid JSON body',
      },
      { status: 400 }
    );
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY;
  if (!secretKey) {
    return NextResponse.json(
      {
        error:
          'Pulse attach not yet configured. Set STRIPE_SECRET_KEY in your environment.',
      },
      { status: 503 }
    );
  }
  if (!priceId) {
    return NextResponse.json(
      {
        error:
          'Pulse attach not yet configured. Set NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY.',
      },
      { status: 503 }
    );
  }

  // Defensive lookup — confirm the (publicId, stripeCustomerId) pair
  // matches an existing client row. Without this, an attacker could
  // hit the endpoint with a stolen publicId + their own customer id
  // and bind someone else's Pulse subscription to themselves. The
  // join also catches stale state (client deleted, customer id drift,
  // etc.).
  const supabase = getServerSupabase();
  const { data: client, error: lookupError } = await supabase
    .from('clients')
    .select(
      'id, public_id, business_name, stripe_customer_id, tier, billing_mode'
    )
    .eq('public_id', body.publicId)
    .eq('stripe_customer_id', body.stripeCustomerId)
    .maybeSingle<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'business_name'
        | 'stripe_customer_id'
        | 'tier'
        | 'billing_mode'
      >
    >();

  if (lookupError) {
    return NextResponse.json(
      { error: `client lookup failed: ${lookupError.message}` },
      { status: 500 }
    );
  }
  if (!client) {
    return NextResponse.json(
      {
        error:
          "We couldn't match your order to a TurfMap client. Refresh and try again, or email support@turfmap.ai.",
      },
      { status: 404 }
    );
  }

  // No-op short-circuit if Pulse is already attached. Defensive: the
  // attach panel hides itself client-side once tier is pulse/pulse_plus,
  // but a stale tab or double-click could still POST here.
  if (client.tier === 'pulse' || client.tier === 'pulse_plus') {
    return NextResponse.json(
      {
        error:
          "Pulse is already active on this account — open your portal to manage it.",
      },
      { status: 409 }
    );
  }

  // Lazy-import Stripe so build environments without the SDK still
  // compile (we only reach here when STRIPE_SECRET_KEY is set, which
  // implies Stripe is installed).
  let Stripe: typeof import('stripe').default;
  try {
    Stripe = (await import('stripe')).default;
  } catch {
    return NextResponse.json(
      { error: 'Stripe SDK not installed.' },
      { status: 503 }
    );
  }

  const stripe = new Stripe(secretKey);

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';

  try {
    // Defensive: confirm the Stripe customer still exists. Catches
    // the rare case where the customer was deleted between original
    // purchase + attach click. Stripe returns deleted: true on
    // tombstoned customers; treat as not-found.
    const customer = await stripe.customers.retrieve(body.stripeCustomerId);
    if ('deleted' in customer && customer.deleted) {
      return NextResponse.json(
        {
          error:
            'Your Stripe customer record was removed. Email support@turfmap.ai.',
        },
        { status: 404 }
      );
    }

    // Stripe Checkout session. Three things to know:
    //
    //   1. mode='subscription' + trial_period_days=30 captures the
    //      card on day 0 and starts billing on day 31. No charge in
    //      the trial window. Cancel anytime before day 31 = $0.
    //
    //   2. subscription_data.metadata.client_id is the link the
    //      existing /api/stripe/webhook handler uses to find the
    //      right client row when customer.subscription.created
    //      fires (status='trialing'). The handler writes
    //      tier='pulse' and subscription_status='trialing' onto
    //      that row — no new row created.
    //
    //   3. attach_source='order_success' on the session metadata
    //      lets us slice trial→paid conversion in the Stripe
    //      dashboard + checkout.session.completed payloads.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: body.stripeCustomerId,
      // payment_method_collection: 'always' is required when there's
      // a trial — without it Stripe would skip card capture and we'd
      // have nothing to charge on day 31.
      payment_method_collection: 'always',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 30,
        metadata: {
          client_id: client.id,
          attach_source: 'order_success',
          original_tier: client.tier ?? 'unknown',
        },
      },
      // Surface the offer language + cancellation reassurance in the
      // Stripe Checkout UI itself — operators reviewing their card
      // capture see exactly what the buyer agreed to.
      custom_text: {
        submit: {
          message:
            'No charge today. $39/mo starts in 30 days. Cancel anytime before then to pay nothing.',
        },
      },
      // Round-trip the ORIGINAL one-time session_id so the success
      // page rehydrates its prior "Your TurfMap is ready" state. The
      // attach=success / attach=cancelled flag is what flips the
      // attach-panel into a confirmation banner (or back to the
      // un-attached offer if they cancelled).
      success_url: `${origin}/order/success?session_id=${body.originalSessionId}&attach=success`,
      cancel_url: `${origin}/order/success?session_id=${body.originalSessionId}&attach=cancelled`,
      metadata: {
        attach_source: 'order_success',
        public_id: client.public_id,
        client_id: client.id,
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
      { error: `Pulse attach failed: ${message}` },
      { status: 502 }
    );
  }
}
