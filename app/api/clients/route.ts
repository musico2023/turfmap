/**
 * POST /api/clients — onboard a new client.
 *
 * Body:
 *   {
 *     business_name, address, latitude, longitude,
 *     industry?, service_radius_miles?, primary_color?, monthly_price_cents?,
 *     status?,
 *     keyword: { keyword, scan_frequency?, is_primary? }
 *   }
 *
 * Creates a `clients` row and one `tracked_keywords` row in a single
 * (best-effort transactional) flow. If the keyword insert fails, we delete
 * the client row to avoid orphans.
 *
 * Returns: { id, slug } on success, or { error } on failure.
 */

import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { getStripe } from '@/lib/stripe/client';
import { sendStripeSetupLink } from '@/lib/email/resend';
import {
  enrichLocationFromOnboarding,
  selectMatchManually,
} from '@/lib/google/enrich';
import type { ClientStatus, ScanFrequency } from '@/lib/supabase/types';
import { agencyClientUrl } from '@/lib/urls';
import { hasLocatableCenter } from '@/lib/intake/requireLocatable';

export const runtime = 'nodejs';

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const CreateClientBody = z.object({
  business_name: z.string().min(2).max(200),
  address: z.string().max(400).optional().nullable(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Structured NAP fields — required by BrightLocal Listings API. Optional
  // here so older API consumers don't break, but the create form sends them.
  phone: z.string().min(4).max(40).optional().nullable(),
  street_address: z.string().min(1).max(200).optional().nullable(),
  city: z.string().min(1).max(120).optional().nullable(),
  region: z.string().min(1).max(120).optional().nullable(),
  postcode: z.string().min(1).max(20).optional().nullable(),
  country_code: z
    .string()
    .length(3, 'ISO-3166-1 alpha-3 (e.g. USA)')
    .optional()
    .nullable(),
  industry: z.string().max(80).optional().nullable(),
  service_radius_miles: z.number().min(0.1).max(10).optional(),
  // Google Place ID from the agency form's GBP autocomplete pick.
  // When present, the create flow stamps it on client_locations
  // directly and short-circuits the fuzzy back-matcher
  // (enrichLocationFromOnboarding) in favor of the
  // operator-confirmed path (selectMatchManually). Optional — the
  // legacy Mapbox/manual-entry flow is still supported.
  google_place_id: z.string().min(4).max(300).optional().nullable(),
  primary_color: z
    .string()
    .regex(HEX_COLOR, 'must be hex like #c5ff3a')
    .optional(),
  monthly_price_cents: z.number().int().min(0).optional().nullable(),
  status: z.enum(['active', 'paused', 'churned']).optional(),
  keyword: z.object({
    keyword: z.string().min(2).max(160),
    scan_frequency: z
      .enum(['daily', 'weekly', 'biweekly', 'monthly'])
      .optional(),
    is_primary: z.boolean().optional(),
  }),
  // Plan selector at create time. Drives billing_mode + tier + the
  // optional Stripe-Checkout-link generation. Defaults to
  // agency_managed with tier=pulse_plus to match the most common
  // operator workflow (custom contract, full feature access).
  plan: z
    .enum(['agency_managed', 'pulse', 'pulse_plus'])
    .optional()
    .default('agency_managed'),
  tier: z.enum(['pulse', 'pulse_plus']).optional(),
  /** Required when plan is 'pulse' / 'pulse_plus'. Pre-fills Stripe
   *  Checkout's customer_email field. */
  buyer_email: z.string().email().optional(),
  /** Trial length in days for the Stripe Checkout flow. 0 = no
   *  trial. */
  trial_days: z.number().int().min(0).max(90).optional(),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  let parsed: z.infer<typeof CreateClientBody>;
  try {
    parsed = CreateClientBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  if (!hasLocatableCenter({ latitude: parsed.latitude, longitude: parsed.longitude, address: parsed.address })) {
    return NextResponse.json(
      { error: 'Pick the business on Google or enter a city/address — we need a location to center the scan.' },
      { status: 400 }
    );
  }

  // Resolve plan-driven billing fields. The Stripe path needs a
  // buyer email + tier; reject early if those are missing rather
  // than half-creating a row that points nowhere.
  const isStripePlan =
    parsed.plan === 'pulse' || parsed.plan === 'pulse_plus';
  if (isStripePlan && !parsed.buyer_email) {
    return NextResponse.json(
      { error: 'buyer_email is required for Pulse / Pulse+ plans' },
      { status: 400 }
    );
  }
  // Tier on the new row. For agency-managed clients, take it from
  // body.tier (defaulting to pulse_plus since that's the typical
  // bundled-contract value). For Stripe plans, tier matches the
  // plan name so feature gates work even before checkout completes.
  const planDrivenTier: 'pulse' | 'pulse_plus' = isStripePlan
    ? (parsed.plan as 'pulse' | 'pulse_plus')
    : (parsed.tier ?? 'pulse_plus');
  const planDrivenBillingMode: 'agency_managed' | 'self_serve_subscription' =
    isStripePlan ? 'self_serve_subscription' : 'agency_managed';

  const supabase = getServerSupabase();

  // 1. Insert clients row. Location columns are dual-written here as
  //    deprecated mirrors so existing read sites don't break; the
  //    canonical location data also goes into client_locations below.
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: parsed.business_name,
      address: parsed.address,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      phone: parsed.phone ?? null,
      street_address: parsed.street_address ?? null,
      city: parsed.city ?? null,
      region: parsed.region ?? null,
      postcode: parsed.postcode ?? null,
      country_code: parsed.country_code ?? 'USA',
      industry: parsed.industry ?? null,
      service_radius_miles: parsed.service_radius_miles ?? 1.6,
      primary_color: parsed.primary_color ?? '#c5ff3a',
      monthly_price_cents: parsed.monthly_price_cents ?? null,
      status: (parsed.status ?? 'active') as ClientStatus,
      tier: planDrivenTier,
      billing_mode: planDrivenBillingMode,
      // Persisted only for Stripe-plan creates so the regenerate-
      // checkout flow + auto-email both have it without making the
      // operator re-enter. Cleared once the buyer completes Checkout
      // (Stripe customer.email becomes the source of truth).
      pending_buyer_email: isStripePlan ? parsed.buyer_email : null,
    })
    .select('id, public_id')
    .single<{ id: string; public_id: string }>();

  if (clientErr || !client) {
    return NextResponse.json(
      { error: `client insert failed: ${clientErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  // 2. Insert the primary location row. This is the canonical storage
  //    for NAP + scan-grid data going forward. We need the inserted id
  //    to attach the primary keyword to it (post-migration 0010 keywords
  //    are scoped per-location; an orphan keyword with location_id=NULL
  //    won't be picked up by the location-scoped scan-trigger lookup).
  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: parsed.city ?? null,
      address: parsed.address,
      street_address: parsed.street_address ?? null,
      city: parsed.city ?? null,
      region: parsed.region ?? null,
      postcode: parsed.postcode ?? null,
      country_code: parsed.country_code ?? 'USA',
      phone: parsed.phone ?? null,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      service_radius_miles: parsed.service_radius_miles ?? 1.6,
      // Stamp the GBP id directly when the operator picked one
      // from the autocomplete. The enrichment hook below detects
      // this and runs the operator-confirmed path
      // (selectMatchManually) instead of the fuzzy back-lookup
      // (enrichLocationFromOnboarding) — saves a Places Search
      // round-trip and avoids the risk of the back-matcher
      // disagreeing with the operator's pick.
      google_place_id: parsed.google_place_id ?? null,
    })
    .select('id')
    .single<{ id: string }>();
  if (locErr || !location) {
    await supabase.from('clients').delete().eq('id', client.id);
    return NextResponse.json(
      {
        error: `primary location insert failed (client rolled back): ${locErr?.message ?? 'no row'}`,
      },
      { status: 500 }
    );
  }

  // Google Places enrichment for the primary location — fire-and-forget.
  // Two paths, soft-fails on every branch:
  //
  //   - When the operator picked a GBP from the agency form's
  //     autocomplete, the place_id is already stamped on the row;
  //     selectMatchManually just fetches Place Details and lands
  //     the gbp_signals snapshot. Skips the fuzzy back-matcher
  //     entirely.
  //
  //   - When no place_id is on the row (legacy/manual-entry flow),
  //     enrichLocationFromOnboarding runs the original name +
  //     coords back-lookup so the location still gets a GBP match
  //     attempt.
  after(async () => {
    if (parsed.google_place_id) {
      await selectMatchManually(supabase, {
        locationId: location.id,
        placeId: parsed.google_place_id,
      });
    } else {
      await enrichLocationFromOnboarding(supabase, {
        locationId: location.id,
        businessName: parsed.business_name,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      });
    }
  });

  // 3. Insert primary keyword, scoped to the location we just created.
  //    Roll back both the client and its primary location on failure
  //    (cascade handles the latter).
  const { error: kwErr } = await supabase.from('tracked_keywords').insert({
    client_id: client.id,
    location_id: location.id,
    keyword: parsed.keyword.keyword,
    scan_frequency: (parsed.keyword.scan_frequency ?? 'weekly') as ScanFrequency,
    is_primary: parsed.keyword.is_primary ?? true,
  });

  if (kwErr) {
    await supabase.from('clients').delete().eq('id', client.id);
    return NextResponse.json(
      { error: `keyword insert failed (client rolled back): ${kwErr.message}` },
      { status: 500 }
    );
  }

  // 4. (Stripe-plan only) Generate a Checkout session the operator
  //    can forward to the buyer. We DON'T fail the whole create
  //    request if Stripe Checkout-session generation fails — the
  //    row exists and is usable; the operator can regenerate the
  //    Checkout link later from settings. We surface the error
  //    inline as `checkout_error` so the UI can warn.
  let checkoutUrl: string | null = null;
  let checkoutError: string | null = null;
  if (isStripePlan) {
    const stripe = await getStripe();
    if (!stripe) {
      checkoutError =
        'STRIPE_SECRET_KEY not set — Checkout link skipped. Generate later from settings.';
    } else {
      const priceEnvKey =
        parsed.plan === 'pulse_plus'
          ? 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY'
          : 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY';
      const priceId = process.env[priceEnvKey];
      if (!priceId) {
        checkoutError = `${priceEnvKey} not set — Checkout link skipped.`;
      } else {
        try {
          const origin =
            process.env.NEXT_PUBLIC_APP_URL ??
            req.headers.get('origin') ??
            'https://turfmap.ai';
          const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: parsed.buyer_email,
            // Trial captured via subscription_data — Stripe creates
            // the sub in 'trialing' status and only attempts the
            // first charge when the trial ends. trial_days=0 is
            // omitted so Stripe charges immediately.
            ...(parsed.trial_days && parsed.trial_days > 0
              ? {
                  subscription_data: {
                    trial_period_days: parsed.trial_days,
                    metadata: {
                      client_id: client.id,
                      plan: parsed.plan,
                    },
                  },
                }
              : {
                  subscription_data: {
                    metadata: {
                      client_id: client.id,
                      plan: parsed.plan,
                    },
                  },
                }),
            // Session-level metadata mirrors so the order-fulfill
            // path (which reads session.metadata.tier) works
            // unchanged for marketing-tripwire buyers.
            metadata: {
              tier: parsed.plan,
              client_id: client.id,
            },
            success_url: `${agencyClientUrl(origin, client.public_id)}?stripe_setup=complete`,
            cancel_url: `${agencyClientUrl(origin, client.public_id)}?stripe_setup=cancelled`,
            allow_promotion_codes: true,
          });
          checkoutUrl = session.url ?? null;
          if (!checkoutUrl) {
            checkoutError = 'Stripe returned no Checkout URL.';
          }
        } catch (e) {
          checkoutError =
            e instanceof Error ? e.message : 'unknown Stripe error';
        }
      }
    }
  }

  // Auto-email the Checkout link to the buyer. Best-effort: a
  // Resend failure shouldn't fail the create response — the
  // operator still has the URL to forward manually. The email
  // result lands on the response so the UI can confirm delivery
  // (or surface the failure to the operator).
  let setupEmailSent = false;
  if (
    isStripePlan &&
    checkoutUrl &&
    parsed.buyer_email &&
    parsed.plan !== 'agency_managed'
  ) {
    setupEmailSent = await sendStripeSetupLink({
      to: parsed.buyer_email,
      businessName: parsed.business_name,
      tier: parsed.plan as 'pulse' | 'pulse_plus',
      trialDays: parsed.trial_days ?? 0,
      checkoutUrl,
    });
  }

  return NextResponse.json({
    id: client.id,
    public_id: client.public_id,
    checkout_url: checkoutUrl,
    checkout_error: checkoutError,
    setup_email_sent: setupEmailSent,
  });
}
