/**
 * Stripe Checkout session helpers.
 *
 * Both the order-success page (server component) and the order-fulfill
 * API need to look up a Stripe Checkout session and extract the same
 * fields (tier, customer email, payment status, customer id, amount).
 * This module is the single place that knows the session shape.
 */

import { getStripe } from './client';
import type { Tier } from '@/lib/supabase/types';

export type LoadedSession = {
  /** The original session id (round-trips for downstream calls). */
  sessionId: string;
  /** Product tier — sourced from session.metadata.tier set by
   *  /api/checkout/[tier] when creating the session. Validated
   *  against the Tier union here so downstream code never has to
   *  re-check. */
  tier: Tier;
  /** Buyer email — checkout sessions store this on session.customer_details
   *  for both one-time AND subscription mode. Used to pre-fill the
   *  fulfill form + send the confirmation email. */
  customerEmail: string | null;
  /** Stripe Customer object id. For one-time payments this is set
   *  when customer_creation='if_required' captured a customer; for
   *  subscriptions it's always set. */
  customerId: string | null;
  /** Subscription id, only present for subscription-mode sessions. */
  subscriptionId: string | null;
  /** 'paid' / 'unpaid' / 'no_payment_required' — only proceed if 'paid'. */
  paymentStatus: string | null;
  /** Cents. For audit-tier surfacing in lead_orders.stripe_metadata
   *  + analytics. */
  amountTotal: number | null;
  /** ISO currency code. */
  currency: string | null;
  /** Cold-email cohort prospect id, if the session originated from
   *  a /yourmap purchase. NULL for organic / popup-cohort buyers.
   *  Fulfill route uses this to stamp prospects.converted_at. */
  prospectId: string | null;
  /** Cohort discriminator from session.metadata.cohort. Set by the
   *  /api/checkout/[tier] route — derives from the coupon (VIP →
   *  crm_reactivation_q2) or prospect_id presence (cold_email). NULL
   *  for organic / popup-cohort buyers. Drives upsell suppression on
   *  /order/success + dashboard for warm-cohort buyers per the
   *  campaign brief's MUST-NOT-render rules. */
  cohort: string | null;
  /** UPPERCASE coupon code stamped onto session metadata by the
   *  init/checkout route (MAPCHECK50, FOURDOTS50, VIP, COLDSCAN, etc.).
   *  Surfaced here so the operator Slack feed + analytics can attribute
   *  conversions to the coupon without re-fetching the session. NULL
   *  for full-price buyers. */
  coupon: string | null;
  /** utm_source from session metadata — typically 'meta_cold',
   *  'cold_email', 'fourdots_homepage', 'warm_reactivation'. */
  utmSource: string | null;
  /** utm_content from session metadata — Meta ad-creative variant
   *  identifier. Required for paid-Meta conversion-by-creative
   *  reporting. */
  utmContent: string | null;
  /**
   * Intake-first payload — populated when /api/scan/checkout/init
   * stamped the intake fields onto session.metadata. Non-null iff
   * metadata.source === 'scan_intake'.
   *
   * When present, /order/success auto-fulfills the order from this
   * payload instead of prompting the buyer for the same fields a
   * second time. NULL for the legacy Stripe-first flows used by
   * /fourdots / /yourmap / /freescan (those still surface the form).
   */
  intake: {
    businessName: string;
    address: string;
    /** Primary keyword — always present + always equal to keywords[0]. */
    keyword: string;
    /** Full keywords list. One element for scan/audit; three for
     *  strategy. Stamped on Stripe metadata as keyword_1, keyword_2,
     *  keyword_3 + keyword_count so /order/success can pass the full
     *  array to /api/orders/fulfill. */
    keywords: string[];
    email: string;
    phone: string;
    /** Mapbox-picked latitude. When non-null, fulfill should USE
     *  these coordinates directly instead of re-geocoding the
     *  address — that re-geocode is the path that produced wrong-
     *  city matches for ambiguously-named streets. */
    latitude: number | null;
    longitude: number | null;
    /** Structured address components from the Mapbox pick. Used by
     *  fulfill to populate clients.{street_address, city, region,
     *  postcode, country_code} without re-parsing the freeform
     *  string. Null when the buyer typed freely. */
    components: {
      street_address: string | null;
      city: string | null;
      region: string | null;
      postcode: string | null;
      country_code: string | null;
    } | null;
    /** Google Place ID stamped by /api/scan/checkout/init when the
     *  buyer picked from the PlaceAutocompleteElement on /intake.
     *  When present, the fulfill route stamps it directly on
     *  client_locations.google_place_id (with match_status='manual')
     *  so the gbp_signals enrichment skips Text Search. Null when
     *  the buyer used the legacy Mapbox path. */
    googlePlaceId: string | null;
    /** Google Business Profile primary category — Google's
     *  place_types enum value (e.g. 'steak_house', 'plumber').
     *  Forwarded for downstream context (trade-economics inference,
     *  category-aware AI Coach prompting). Null on the legacy
     *  Mapbox path. */
    googlePrimaryType: string | null;
  } | null;
  /**
   * Score-funnel unlock payload — populated when
   * /api/score/unlock-init stamped score_unlock metadata on this
   * session. Non-null iff metadata.source === 'score_unlock'.
   *
   * When present, /order/success skips the intake form + the
   * auto-fulfill flow entirely (the webhook handler already did
   * the work) and renders the post-success card directly with a
   * prominent "View your scan" link to /share/<shareId>. NULL for
   * every other entry path.
   */
  scoreUnlock: {
    shareId: string;
    clientId: string;
    scanId: string;
  } | null;
};

/** Errors callers should distinguish: we want a clean way to know
 *  whether we 4xx (bad input) vs 503 (unconfigured) vs 502 (Stripe
 *  errored). */
export type LoadSessionError =
  | { kind: 'stripe_not_configured' }
  | { kind: 'invalid_tier'; tierValue: string | null }
  | { kind: 'session_not_found' }
  | { kind: 'payment_not_complete'; paymentStatus: string | null }
  | { kind: 'stripe_error'; message: string };

const TIER_VALUES: ReadonlySet<Tier> = new Set<Tier>([
  'scan',
  'audit',
  'strategy',
  'pulse',
  'pulse_plus',
]);

function isTier(value: string | null | undefined): value is Tier {
  return value != null && TIER_VALUES.has(value as Tier);
}

/**
 * Fetch a Stripe Checkout session and validate it for fulfillment.
 *
 * Caller pattern:
 *   const result = await loadCheckoutSession(sessionId);
 *   if ('kind' in result) { return errorEnvelope(result); }
 *   // result is a LoadedSession — proceed.
 *
 * The dual-return shape lets us preserve type safety on the success
 * branch while giving callers structured error info to format
 * appropriate HTTP responses (503 / 400 / 502).
 */
export async function loadCheckoutSession(
  sessionId: string
): Promise<LoadedSession | LoadSessionError> {
  const stripe = await getStripe();
  if (!stripe) return { kind: 'stripe_not_configured' };

  let session: import('stripe').Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      // Expand customer details so we get the email even when no
      // Customer object was created (one-time payments without
      // customer_creation can leave customer_details populated and
      // customer null).
      expand: ['customer', 'subscription'],
    });
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : 'unknown';
    // Stripe 404s come through with a code we could match on, but
    // for our purposes either "not found" or "wrong account" land
    // here. session_not_found is the right user-facing framing.
    if (message.toLowerCase().includes('no such checkout.session')) {
      return { kind: 'session_not_found' };
    }
    return { kind: 'stripe_error', message };
  }

  const tierRaw =
    session.metadata && 'tier' in session.metadata
      ? String(session.metadata.tier)
      : null;
  if (!isTier(tierRaw)) {
    return { kind: 'invalid_tier', tierValue: tierRaw };
  }

  if (session.payment_status !== 'paid') {
    return {
      kind: 'payment_not_complete',
      paymentStatus: session.payment_status ?? null,
    };
  }

  // customer can come back as either a string id or an expanded
  // Customer object; normalize to string id either way.
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer && 'id' in session.customer
        ? session.customer.id
        : null;

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription && 'id' in session.subscription
        ? session.subscription.id
        : null;

  const customerEmail =
    session.customer_details?.email ??
    (typeof session.customer === 'object' &&
    session.customer &&
    'email' in session.customer
      ? session.customer.email
      : null) ??
    null;

  // Optional cold-email cohort marker, set by /api/checkout/[tier]
  // when the lander forwarded ?prospect_id=<nanoid>. Read back here
  // so callers can stamp prospects.converted_at without re-fetching
  // the session.
  const prospectId =
    session.metadata && 'prospect_id' in session.metadata
      ? String(session.metadata.prospect_id) || null
      : null;

  // Cohort discriminator set by /api/checkout/[tier] (VIP coupon →
  // crm_reactivation_q2; prospect_id present → cold_email; otherwise
  // null). Used by /order/success + dashboard to suppress the audit
  // upsell + Pulse attach panels for warm-cohort buyers per the
  // campaign brief's "MUST NOT render" rules.
  const cohort =
    session.metadata && 'cohort' in session.metadata
      ? String(session.metadata.cohort) || null
      : null;

  // Attribution surface — coupon + utm_source + utm_content. Each
  // stamped by the upstream checkout init route(s). Surfaced on
  // LoadedSession so /api/orders/fulfill can include them on the
  // operator Slack notification without re-fetching the session.
  const coupon =
    session.metadata && 'coupon' in session.metadata
      ? String(session.metadata.coupon) || null
      : null;
  const utmSource =
    session.metadata && 'utm_source' in session.metadata
      ? String(session.metadata.utm_source) || null
      : null;
  const utmContent =
    session.metadata && 'utm_content' in session.metadata
      ? String(session.metadata.utm_content) || null
      : null;

  // Intake-first payload — set by /api/scan/checkout/init when the
  // buyer filled the /scan/intake form BEFORE Stripe. /order/success
  // checks this to decide whether to auto-fulfill (intake-first) vs
  // prompt the buyer for the same fields again (legacy Stripe-first).
  const metaSource =
    session.metadata && 'source' in session.metadata
      ? String(session.metadata.source) || null
      : null;
  let intake: LoadedSession['intake'] = null;
  if (metaSource === 'scan_intake' && session.metadata) {
    const m = session.metadata as Record<string, string | undefined>;
    const businessName = m.business_name?.trim();
    const address = m.address?.trim();
    const keyword = m.keyword?.trim();
    const intakeEmail = m.intake_email?.trim();
    const phone = m.phone?.trim();
    // All five fields are required by the /scan/intake form +
    // mirrored in the Zod schema of /api/scan/checkout/init. If any
    // are missing here something stamped the session externally —
    // bail to null so /order/success falls back to the legacy form
    // instead of submitting half-populated fulfill.
    if (businessName && address && keyword && intakeEmail && phone) {
      // Optional Mapbox-picked geo + structured components. Parsed
      // defensively — if either lat or lng fails Number(), we treat
      // the pick as missing and fulfill falls back to Nominatim.
      const latStr = m.latitude;
      const lngStr = m.longitude;
      const lat = latStr ? Number(latStr) : NaN;
      const lng = lngStr ? Number(lngStr) : NaN;
      const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
      const components = {
        street_address: m.street_address?.trim() || null,
        city: m.city?.trim() || null,
        region: m.region?.trim() || null,
        postcode: m.postcode?.trim() || null,
        country_code: m.country_code?.trim() || null,
      };
      // Only attach `components` when at least one structured field
      // is populated — keeps null distinguishable from "all empty"
      // for downstream typecheck consumers.
      const hasComponents = Object.values(components).some((v) => v !== null);

      // Rebuild keywords[] from keyword_1/2/3 + keyword_count. For
      // back-compat with sessions stamped before strategy-tier
      // support (keyword_1..3 absent), fall back to [keyword]. The
      // count metadata field guards against under-populated arrays
      // when only the singular field was stamped.
      const declaredCount = Number(m.keyword_count ?? '1');
      const numericCount = Number.isFinite(declaredCount)
        ? Math.max(1, Math.min(3, Math.round(declaredCount)))
        : 1;
      const collected: string[] = [];
      for (let i = 1; i <= numericCount; i++) {
        const kw = m[`keyword_${i}`]?.trim();
        if (kw) collected.push(kw);
      }
      const keywords = collected.length > 0 ? collected : [keyword];

      intake = {
        businessName,
        address,
        keyword,
        keywords,
        email: intakeEmail,
        phone,
        latitude: hasGeo ? lat : null,
        longitude: hasGeo ? lng : null,
        components: hasComponents ? components : null,
        googlePlaceId: m.google_place_id?.trim() || null,
        googlePrimaryType: m.google_primary_type?.trim() || null,
      };
    }
  }

  // ─── Score-funnel unlock payload ─────────────────────────────────
  // Stamped by /api/score/unlock-init on the Stripe Checkout session.
  // When present, /order/success skips the form + auto-fulfill and
  // renders the post-success card directly (the webhook handler
  // already did the actual work).
  let scoreUnlock: LoadedSession['scoreUnlock'] = null;
  if (metaSource === 'score_unlock' && session.metadata) {
    const m = session.metadata as Record<string, string | undefined>;
    const shareId = m.share_id?.trim();
    const unlockClientId = m.client_id?.trim();
    const scanId = m.scan_id?.trim();
    if (shareId && unlockClientId && scanId) {
      scoreUnlock = {
        shareId,
        clientId: unlockClientId,
        scanId,
      };
    }
  }

  return {
    sessionId,
    tier: tierRaw,
    customerEmail,
    customerId,
    subscriptionId,
    paymentStatus: session.payment_status ?? null,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    prospectId,
    cohort,
    coupon,
    utmSource,
    utmContent,
    intake,
    scoreUnlock,
  };
}
