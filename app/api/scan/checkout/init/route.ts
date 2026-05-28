/**
 * POST /api/scan/checkout/init
 *
 * Intake-first checkout initializer for the cold-Meta /scan funnel.
 *
 * Sister to /api/checkout/scan (the legacy Stripe-first init used by
 * /fourdots, /yourmap, /freescan) — the difference is sequencing:
 *   - Legacy:  buyer clicks CTA -> Stripe Checkout -> /order/success
 *              form -> POST /api/orders/fulfill -> scan fires.
 *   - This:    buyer clicks CTA -> /scan/intake form -> POST here ->
 *              Stripe Checkout -> /order/success auto-fulfills using
 *              session metadata -> scan fires.
 *
 * The intake fields (businessName, address, keyword, email, phone) are
 * collected BEFORE Stripe and stamped onto the Checkout session's
 * `metadata` so /order/success can fulfill server-side without a
 * second form fill. Buyer experiences: form -> pay -> scan running.
 *
 * Why a separate route from /api/checkout/[tier]:
 *   - That route is POST-with-URL-search-params (no body), heavily
 *     polymorphic across 5 tiers + 2 cadences + 4 coupon paths. Layering
 *     intake-body semantics on top would muddy a working surface.
 *   - This is single-tier (scan only), single-coupon (MAPCHECK50 path)
 *     and JSON-body in. Cleaner to keep them separate.
 *
 * Body:    { businessName, address, keyword, email, phone,
 *            coupon?, utm_source?, utm_medium?, utm_campaign?, gclid? }
 * Returns: { url }  — Stripe Checkout URL; client redirects there.
 *
 * Errors:
 *   - 400: Zod validation failure
 *   - 503: Stripe not configured (env vars missing)
 *   - 502: Stripe API error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getStripe, STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  businessName: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
  keyword: z.string().min(2).max(160),
  email: z.string().email(),
  phone: z.string().min(7).max(40),
  coupon: z.string().max(40).optional(),
  utm_source: z.string().max(120).optional(),
  utm_medium: z.string().max(120).optional(),
  utm_campaign: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
  }

  const priceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_SCAN;
  if (!priceId) {
    return NextResponse.json(
      { error: 'scan price id not configured (NEXT_PUBLIC_STRIPE_PRICE_SCAN)' },
      { status: 503 }
    );
  }

  // Resolve the coupon code (default MAPCHECK50 for /scan) into Stripe's
  // promotion_code id. If lookup fails or the code is invalid we'll
  // retry-without-discount below — the buyer still reaches Checkout at
  // the full $99 list and can hand-enter a valid code there.
  const couponCode = (body.coupon ?? 'MAPCHECK50').trim().toUpperCase();
  let discounts:
    | Array<{ promotion_code: string }>
    | undefined;
  if (couponCode) {
    try {
      const promos = await stripe.promotionCodes.list({
        code: couponCode,
        active: true,
        limit: 1,
      });
      if (promos.data[0]?.id) {
        discounts = [{ promotion_code: promos.data[0].id }];
      }
    } catch {
      // Soft-fail — proceed without the discount.
    }
  }

  const url = new URL(req.url);
  const origin = req.headers.get('origin') ?? url.origin;

  // Stamp ALL intake fields onto Stripe metadata so /order/success can
  // fulfill the scan without re-prompting the buyer. Metadata is a flat
  // string-string map — keep values reasonably-sized (Stripe caps at
  // 500 chars per value, 50 keys per session; we're well under both).
  //
  // source='scan_intake' is the discriminator /order/success uses to
  // decide whether to auto-fulfill or show the legacy form.
  const metadata: Record<string, string> = {
    tier: 'scan',
    source: 'scan_intake',
    business_name: body.businessName.trim(),
    address: body.address.trim(),
    keyword: body.keyword.trim(),
    intake_email: body.email.trim(),
    phone: body.phone.trim(),
    coupon: couponCode,
  };
  if (body.utm_source) metadata.utm_source = body.utm_source;
  if (body.utm_medium) metadata.utm_medium = body.utm_medium;
  if (body.utm_campaign) metadata.utm_campaign = body.utm_campaign;
  if (body.gclid) metadata.gclid = body.gclid;

  const baseParams: import('stripe').default.Checkout.SessionCreateParams = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    // Pre-fill buyer email on the Stripe page from the intake form.
    customer_email: body.email.trim(),
    // 'always' creates a Stripe customer for every paid scan, which the
    // 1-click audit upgrade on /order/success needs to pre-bind the
    // upgrade Checkout to the saved card.
    customer_creation: 'always',
    payment_intent_data: {
      // Save the card off-session so the audit-upgrade PaymentIntent
      // can charge it without re-prompting for card details.
      setup_future_usage: 'off_session',
    },
    success_url: `${origin}/order/success?tier=scan&session_id={CHECKOUT_SESSION_ID}`,
    // Bounce a cancelled checkout back to the intake page with a flag —
    // the page can render a softer "no problem, your details are saved"
    // recovery message in a future iteration.
    cancel_url: `${origin}/scan/intake?cancelled=1`,
    metadata,
  };

  try {
    let session: import('stripe').default.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        ...baseParams,
        ...(discounts
          ? { discounts }
          : { allow_promotion_codes: true }),
      });
    } catch (e) {
      // Discount rejected (invalid / expired) — retry without it so
      // the buyer doesn't get blocked at Stripe.
      if (discounts) {
        // eslint-disable-next-line no-console
        console.warn(
          '[scan/checkout/init] retrying without discount:',
          e instanceof Error ? e.message : String(e)
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
        { error: 'Stripe returned no checkout URL' },
        { status: 502 }
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Stripe Checkout failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 502 }
    );
  }
}
