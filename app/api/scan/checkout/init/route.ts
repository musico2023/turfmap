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
import {
  INTAKE_TIERS,
  INTAKE_TIER_CONFIGS,
  type IntakeTier,
} from '@/lib/checkout/intakeTiers';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  /** Tier the buyer is purchasing. Defaults to 'scan' so legacy
   *  callers that don't send a tier (the pre-tier-aware /scan/intake
   *  form) keep working. Audit ($499) and scan ($99) supported; the
   *  strategy tier is intentionally not yet supported here (3-keyword
   *  intake variant TBD). */
  tier: z
    .enum(INTAKE_TIERS as readonly [IntakeTier, ...IntakeTier[]])
    .default('scan'),
  businessName: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
  keyword: z.string().min(2).max(160),
  email: z.string().email(),
  phone: z.string().min(7).max(40),
  coupon: z.string().max(40).optional(),
  utm_source: z.string().max(120).optional(),
  utm_medium: z.string().max(120).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  /** Meta click id (auto-appended by Facebook/Instagram). Mirror of
   *  gclid for Meta-paid traffic. Stamped on Stripe metadata for
   *  the future Conversion API deduplication path. */
  fbclid: z.string().max(200).optional(),
  /** Cold/warm cohort prospect id. Stamped onto Stripe metadata so the
   *  fulfill pipeline can mark prospects.converted_at on payment. */
  prospect_id: z.string().max(64).optional(),
  /** Lat/lng + structured fields from the Mapbox autocomplete pick.
   *  Forwarded to /order/success → fulfill so we can use Mapbox's
   *  exact coordinates instead of re-Nominatim-geocoding the
   *  freeform string (which caused wrong-city matches for
   *  ambiguously-named streets — see Hendricks Behavioral Hospital
   *  2026-05-19 incident). Omitted when the buyer typed freely. */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  components: z
    .object({
      street_address: z.string().max(200).nullish(),
      city: z.string().max(120).nullish(),
      region: z.string().max(120).nullish(),
      postcode: z.string().max(20).nullish(),
      country_code: z.string().max(8).nullish(),
    })
    .optional(),
});

// Coupons that resolve to a $0 charge after the discount applies.
// Stripe Checkout will reject setup_future_usage='off_session' on a
// $0 PaymentIntent (no card to save), so we omit that param when one
// of these is in play. Mirrors the same hardcoded list in
// /api/checkout/[tier]/route.ts isHundredPercentOffCoupon helper.
function isHundredPercentOffCoupon(couponCode: string | null): boolean {
  if (!couponCode) return false;
  const c = couponCode.toUpperCase();
  return c === 'VIP' || c === 'COLDSCAN';
}

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

  // Pick the Stripe price-id per tier. The tier config carries the
  // env-key name so the existing scan price var (which both this route
  // AND /api/checkout/[tier] read) doesn't need to be re-aliased.
  const tierConfig = INTAKE_TIER_CONFIGS[body.tier];
  const priceId = process.env[tierConfig.priceEnvKey];
  if (!priceId) {
    return NextResponse.json(
      {
        error: `${body.tier} price id not configured (${tierConfig.priceEnvKey})`,
      },
      { status: 503 }
    );
  }

  // Resolve the coupon to Stripe's promotion_code id. NO default — the
  // upstream lander decides whether to send one (FOURDOTS50, MAPCHECK50,
  // VIP, etc.) or none (full $99 list). Soft-fails if lookup errors;
  // the buyer reaches Checkout at list price and can hand-enter a code.
  const couponCode = body.coupon
    ? body.coupon.trim().toUpperCase() || null
    : null;
  let discounts: Array<{ promotion_code: string }> | undefined;
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
    tier: body.tier,
    source: 'scan_intake',
    business_name: body.businessName.trim(),
    address: body.address.trim(),
    keyword: body.keyword.trim(),
    intake_email: body.email.trim(),
    phone: body.phone.trim(),
  };
  if (couponCode) metadata.coupon = couponCode;
  if (body.utm_source) metadata.utm_source = body.utm_source;
  if (body.utm_medium) metadata.utm_medium = body.utm_medium;
  if (body.utm_campaign) metadata.utm_campaign = body.utm_campaign;
  if (body.utm_content) metadata.utm_content = body.utm_content;
  if (body.utm_term) metadata.utm_term = body.utm_term;
  if (body.gclid) metadata.gclid = body.gclid;
  if (body.fbclid) metadata.fbclid = body.fbclid;
  // Mapbox-picked geo — when present, the fulfill route uses these
  // directly and skips Nominatim. Stamped as separate keys (rather
  // than one JSON blob) so they're queryable in the Stripe dashboard
  // + the session loader can typecheck individual values.
  if (
    typeof body.latitude === 'number' &&
    typeof body.longitude === 'number'
  ) {
    metadata.latitude = String(body.latitude);
    metadata.longitude = String(body.longitude);
  }
  if (body.components) {
    const c = body.components;
    if (c.street_address) metadata.street_address = c.street_address;
    if (c.city) metadata.city = c.city;
    if (c.region) metadata.region = c.region;
    if (c.postcode) metadata.postcode = c.postcode;
    if (c.country_code) metadata.country_code = c.country_code;
  }
  // Prospect id + derived cohort marker, mirroring /api/checkout/[tier]:
  // VIP → crm_reactivation_q2 (warm), prospect_id present → cold_email.
  // /order/success + the audit-upgrade gate read these to suppress
  // upsells appropriately for free buyers.
  if (body.prospect_id) {
    metadata.prospect_id = body.prospect_id;
    metadata.cohort =
      couponCode === 'VIP' ? 'crm_reactivation_q2' : 'cold_email';
  } else if (couponCode === 'VIP') {
    metadata.cohort = 'crm_reactivation_q2';
  }

  const hundredOff = isHundredPercentOffCoupon(couponCode);

  const baseParams: import('stripe').default.Checkout.SessionCreateParams = {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: body.email.trim(),
    customer_creation: 'always',
    // Off-session card save powers the 1-click audit upgrade on
    // /order/success. SKIPPED on 100%-off coupons (VIP, COLDSCAN) —
    // Stripe rejects setup_future_usage on a $0 PaymentIntent and the
    // discounted upgrade is gated on amount_total > 0 anyway, so free
    // buyers never use the off-session save.
    ...(hundredOff
      ? {}
      : {
          payment_intent_data: {
            setup_future_usage: 'off_session' as const,
          },
        }),
    success_url: `${origin}/order/success?tier=${body.tier}&session_id={CHECKOUT_SESSION_ID}`,
    // Bounce back to /intake with the same tier/coupon/prospect/utm so
    // a cancelled session lands on a pre-filled form ready to retry.
    cancel_url: (() => {
      const back = new URL(`${origin}/intake`);
      back.searchParams.set('tier', body.tier);
      back.searchParams.set('cancelled', '1');
      if (couponCode) back.searchParams.set('coupon', couponCode);
      if (body.prospect_id) back.searchParams.set('prospect_id', body.prospect_id);
      if (body.utm_source) back.searchParams.set('utm_source', body.utm_source);
      if (body.utm_medium) back.searchParams.set('utm_medium', body.utm_medium);
      if (body.utm_campaign) back.searchParams.set('utm_campaign', body.utm_campaign);
      if (body.utm_content) back.searchParams.set('utm_content', body.utm_content);
      if (body.utm_term) back.searchParams.set('utm_term', body.utm_term);
      if (body.gclid) back.searchParams.set('gclid', body.gclid);
      if (body.fbclid) back.searchParams.set('fbclid', body.fbclid);
      return back.toString();
    })(),
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
