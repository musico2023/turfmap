/**
 * createPreviewClient — sets up a preview client + scan + share link
 * for the /score lead-magnet funnel.
 *
 * What it does (in order, with rollback on any failure):
 *   1. Insert clients row with is_preview=true + status='paused' +
 *      billing_mode='agency_managed' so it's invisible to operator
 *      dashboards, weekly crons, and lead-order counts.
 *   2. Insert primary client_locations row with Mapbox-picked geo
 *      when available (falls back to geocoding the address string
 *      via Nominatim).
 *   3. Insert primary tracked_keywords row.
 *   4. Insert a lead_orders row stamped with source='score_preview'
 *      so the parent funnel is auditable + the share page can detect
 *      preview-mode rendering from the order metadata as well as
 *      from client.is_preview.
 *   5. Run the 81-point DFS scan synchronously via runScanForLocation.
 *   6. Create a scan_share_links row (90-day TTL — same as paid shares).
 *
 * Deliberately does NOT generate AI Coach. That's the most expensive
 * step (~$0.05 Claude call) and lives behind the $99 unlock paywall.
 * The /share/<id> preview-mode rendering replaces the AI Coach panel
 * with a teaser CTA pointing at /api/score/unlock-init.
 *
 * Failure modes:
 *   - Geocode failure → rollback, return { ok: false, kind: 'geocode' }
 *   - DB insert failure → rollback, return { ok: false, kind: 'db' }
 *   - Scan failure → preserve the client+location+keyword rows + the
 *     lead_orders row (operator can retry the scan manually); return
 *     { ok: false, kind: 'scan' }. Note: this means a failed scan
 *     leaves a preview-client orphan, GC'd by the daily cron at 30d.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { runScanForLocation } from '@/lib/scans/runScan';
import { geocodeAddress } from '@/lib/geocoding/nominatim';
import { buildCompetitorReveal } from '@/lib/keywords/competitorReveal';
import { primaryTypeToIndustry } from '@/lib/google/primaryTypeToIndustry';
import type {
  ClientLocationRow,
  ClientRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

// Share TTL matches the paid-scan share default (90 days). Mirrors
// the existing SHARE_LINK_DAYS constant in coldscan-fulfill —
// inlined here so the score module is self-contained, with a comment
// pointing back to the original for future de-duplication.
const SHARE_LINK_DAYS = 90;

export type CreatePreviewClientInput = {
  businessName: string;
  address?: string | null;
  keyword: string;
  email: string;
  phone: string;
  /** Optional Mapbox-picked geo. When BOTH lat and lng are present,
   *  skips Nominatim and uses these directly (prevents wrong-city
   *  matches on ambiguously-named streets). */
  latitude?: number | null;
  longitude?: number | null;
  components?: {
    street_address?: string | null;
    city?: string | null;
    region?: string | null;
    postcode?: string | null;
    country_code?: string | null;
  } | null;
  /** Lander-level identifier used for downstream price differentiation.
   *  Stamped on `lead_orders.stripe_metadata.lead_source`. Known values:
   *    - 'score'       → homepage's free-TurfScore CTA. Unlock = $99.
   *    - 'free_score'  → cold-Meta /free-score lander. Unlock = $49
   *                       (MAPCHECK50 auto-applied by unlock-init).
   *    - undefined     → defaults to 'score' behaviour in unlock-init.
   *  Adding a new lander? Pick a stable slug and document it here. */
  leadSource?: string | null;
  /** Google Place ID of the buyer's business — set when they came in
   *  through the PlaceAutocompleteElement on the lander. Stamped on
   *  `lead_orders.stripe_metadata.google_place_id`. Lets downstream
   *  enrichment flows skip Text Search and go straight to Place Details
   *  (the place_id is the canonical Google identifier). Null when the
   *  buyer used the legacy Mapbox path. */
  googlePlaceId?: string | null;
  /** Google Business Profile primary category — Google's place_types
   *  enum value (e.g. 'steak_house', 'plumber', 'roofing_contractor').
   *  Stamped on `lead_orders.stripe_metadata.google_primary_type`. The
   *  /share/<id> page reads this for niche-accurate trade-economics
   *  inference — far more reliable than keyword-regex matching since
   *  it's the actual Google category, not a buyer-typed search term.
   *  Null when the buyer used the legacy Mapbox path. */
  googlePrimaryType?: string | null;
  /** Attribution payload forwarded from the upstream lander. Captured
   *  to `lead_orders.stripe_metadata.attribution_*` for funnel
   *  reporting and downstream Conversion API dedup. */
  attribution?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    gclid?: string | null;
    fbclid?: string | null;
  } | null;
};

export type CreatePreviewClientResult =
  | {
      ok: true;
      clientId: string;
      shareId: string;
      scanId: string;
      turfScore: number;
    }
  | {
      ok: false;
      kind: 'geocode' | 'db' | 'scan';
      message: string;
    };

export async function createPreviewClient(
  // Loose Supabase client type — accepts either the server-side
  // service-role client or any compatible facade. Mirrors the same
  // pattern used by runScanForLocation + ensurePortalUser.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  input: CreatePreviewClientInput
): Promise<CreatePreviewClientResult> {
  const businessName = input.businessName.trim();
  const addressText = input.address?.trim() ?? '';
  const keywordText = input.keyword.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();

  // ─── 1. Resolve geo ──────────────────────────────────────────────────
  // Prefer the Mapbox pick when both lat + lng landed. Otherwise
  // fall back to Nominatim against the freeform address.
  const hasMapboxPick =
    typeof input.latitude === 'number' &&
    typeof input.longitude === 'number';
  let latitude: number;
  let longitude: number;
  let city: string;
  let countryCode = 'USA';

  if (hasMapboxPick) {
    latitude = input.latitude!;
    longitude = input.longitude!;
    city = input.components?.city?.trim() || addressText;
    countryCode = input.components?.country_code?.trim()?.toUpperCase() || 'USA';
  } else {
    const geocoded = await geocodeAddress(addressText);
    if (!geocoded) {
      return {
        ok: false,
        kind: 'geocode',
        message:
          'Could not resolve that address — try selecting from the dropdown so we can lock the right map location.',
      };
    }
    latitude = geocoded.lat;
    longitude = geocoded.lng;
    city = geocoded.components?.city ?? addressText;
    countryCode = (
      geocoded.components?.country_code ?? 'USA'
    ).toUpperCase();
  }

  // ─── 2. Insert client (is_preview=true, paused, agency-managed) ──────
  // Same paused / agency-managed / not-recurring posture as outreach
  // leads — keeps the preview client out of operator dashboards,
  // weekly cron scans, and lead-order counts. is_preview adds an
  // extra-defense filter on top of all the existing
  // billing_mode='agency_managed' filters.
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: businessName,
      address: addressText,
      latitude,
      longitude,
      city,
      country_code: countryCode,
      service_radius_miles: 1.6,
      status: 'paused',
      billing_mode: 'agency_managed',
      is_preview: true,
    })
    .select('*')
    .single<ClientRow>();
  if (clientErr || !client) {
    return {
      ok: false,
      kind: 'db',
      message: `client insert failed: ${clientErr?.message ?? 'no row returned'}`,
    };
  }

  // Local rollback helper for partial-failure paths.
  const rollback = async () => {
    if (client) {
      await supabase.from('clients').delete().eq('id', client.id);
    }
  };

  // ─── 3. Primary location ─────────────────────────────────────────────
  // Structured NAP fields from the Google Places resolve (or the
  // legacy Mapbox path's `components` block). Stamping these at
  // preview-creation time is the difference between a NAP audit that
  // fires successfully at scan time vs. one that silently skips with
  // `'location missing structured NAP fields'` and leaves the
  // Roadmap PDF's NAP page rendering "NAP audit data unavailable"
  // (CertaPro 2026-06-08 regression — visibility_audits row created
  // but nap_audits row never landed because the location's phone +
  // street_address + region + postcode were null at scan time).
  //
  // Source priority: input.components.* (from ScanIntakeForm's
  // PlaceAutocompleteElement resolve OR Mapbox's onSelect) →
  // null fallback. input.phone comes from the form's hidden phone
  // field (auto-filled from Place Details.nationalPhoneNumber when
  // the buyer picked from the Places dropdown; empty otherwise).
  const napPhone = input.phone || null;
  const napStreet = input.components?.street_address?.trim() || null;
  const napRegion = input.components?.region?.trim() || null;
  const napPostcode = input.components?.postcode?.trim() || null;

  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: city,
      address: addressText,
      city,
      country_code: countryCode,
      latitude,
      longitude,
      service_radius_miles: 1.6,
      // Structured NAP — empty strings normalize to null since
      // maybeRunNapAudit's locationToBusinessProfile() guard treats
      // empty strings as missing (falsy check).
      ...(napPhone ? { phone: napPhone } : {}),
      ...(napStreet ? { street_address: napStreet } : {}),
      ...(napRegion ? { region: napRegion } : {}),
      ...(napPostcode ? { postcode: napPostcode } : {}),
      // Stamp Google Place ID when the buyer picked from the
      // PlaceAutocompleteElement. This lets the existing gbp_signals
      // enrichment pipeline (lib/google/enrich.ts) skip Text Search
      // and go straight to Place Details with a known-good id.
      // google_place_match_status='manual' tells the enrichment
      // system this id was buyer-confirmed, so it should be trusted
      // without re-verification. Null fields are fine when the
      // buyer used the legacy Mapbox path — the enrichment cron
      // can still resolve via Text Search later.
      ...(input.googlePlaceId
        ? {
            google_place_id: input.googlePlaceId,
            google_place_match_status: 'manual' as const,
          }
        : {}),
    })
    .select('*')
    .single<ClientLocationRow>();
  if (locErr || !location) {
    await rollback();
    return {
      ok: false,
      kind: 'db',
      message: `location insert failed: ${locErr?.message ?? 'no row'}`,
    };
  }

  // ─── 4. Primary keyword ──────────────────────────────────────────────
  const { data: keyword, error: kwErr } = await supabase
    .from('tracked_keywords')
    .insert({
      client_id: client.id,
      location_id: location.id,
      keyword: keywordText,
      // 'weekly' so the keyword exists in the recurring-scan cron's
      // candidate universe — but billing_mode='agency_managed' +
      // is_preview=true keep it from actually being picked up.
      scan_frequency: 'weekly',
      is_primary: true,
    })
    .select('*')
    .single<TrackedKeywordRow>();
  if (kwErr || !keyword) {
    await rollback();
    return {
      ok: false,
      kind: 'db',
      message: `keyword insert failed: ${kwErr?.message ?? 'no row'}`,
    };
  }

  // ─── 5. lead_orders stub (source='score_preview') ────────────────────
  // Insert BEFORE the scan so the parent funnel record exists even
  // if the scan fails. status='pending' here — flipped to 'fulfilled'
  // by the score-unlock webhook handler when the buyer pays $99.
  // The source marker is what the share page + downstream funnels
  // check to detect a preview-flow buyer.
  const stripeMetadata: Record<string, string> = {
    source: 'score_preview',
    business_name: businessName,
    keyword: keywordText,
    phone,
  };
  // Stamp the lander identifier so unlock-init can decide whether
  // to auto-apply MAPCHECK50 ($49 Meta-cohort price) vs leave the
  // unlock at $99 (homepage /score traffic).
  if (input.googlePlaceId) {
    stripeMetadata.google_place_id = input.googlePlaceId;
  }
  if (input.googlePrimaryType) {
    stripeMetadata.google_primary_type = input.googlePrimaryType;
  }
  if (input.leadSource) {
    stripeMetadata.lead_source = input.leadSource;
  }
  // Stamp attribution for downstream funnel reporting + Meta CAPI
  // dedup. Skip falsy fields so the metadata stays compact (Stripe
  // has a 500-char value cap and a 50-key cap per object).
  if (input.attribution) {
    const a = input.attribution;
    if (a.utm_source) stripeMetadata.attribution_utm_source = a.utm_source;
    if (a.utm_medium) stripeMetadata.attribution_utm_medium = a.utm_medium;
    if (a.utm_campaign) stripeMetadata.attribution_utm_campaign = a.utm_campaign;
    if (a.utm_content) stripeMetadata.attribution_utm_content = a.utm_content;
    if (a.utm_term) stripeMetadata.attribution_utm_term = a.utm_term;
    if (a.gclid) stripeMetadata.attribution_gclid = a.gclid;
    if (a.fbclid) stripeMetadata.attribution_fbclid = a.fbclid;
  }
  const { error: orderErr } = await supabase.from('lead_orders').insert({
    stripe_session_id: null,
    tier: 'scan',
    status: 'pending',
    email,
    client_id: client.id,
    stripe_metadata: stripeMetadata,
  });
  if (orderErr) {
    await rollback();
    return {
      ok: false,
      kind: 'db',
      message: `order insert failed: ${orderErr.message}`,
    };
  }

  // ─── 6. Run the scan synchronously ───────────────────────────────────
  // ~30-60s typical. We hold the request open so the buyer's redirect
  // lands on a fully-cooked /share/<id> page with the heatmap already
  // computed. AI Coach is deliberately skipped — it's the paywall.
  const scanResult = await runScanForLocation(supabase, {
    client,
    location,
    keyword,
    scanType: 'on_demand',
    triggeredBy: null,
  });
  if (!scanResult.ok) {
    // Don't roll back — preserve the client/location/keyword rows so
    // the operator can retry the scan from the agency dashboard, and
    // so the GC cron eventually cleans them up at 30d if abandoned.
    return {
      ok: false,
      kind: 'scan',
      message: `scan failed: ${scanResult.error}`,
    };
  }

  // ─── 6a. Competitor keyword reveal (flagged, fire-and-forget) ───────
  // Mine the top competitor's keyword gap for the /share reveal. Runs in
  // after() so it never delays the buyer's redirect, and only when
  // COMPETITOR_REVEAL_ENABLED=true so DFS spend stays off until we flip
  // it. Failures are swallowed — the reveal is additive; the scan + share
  // never depend on it.
  if (
    process.env.COMPETITOR_REVEAL_ENABLED === 'true' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  ) {
    const revealScanId = scanResult.scanId;
    after(async () => {
      try {
        await buildCompetitorReveal(supabase, {
          scanId: revealScanId,
          ownName: businessName,
          industry: primaryTypeToIndustry(input.googlePrimaryType ?? null),
          city: city || null,
          lat: latitude,
          lng: longitude,
          countryCode: countryCode || null,
          scannedKeyword: keywordText,
        });
      } catch (e) {
        console.error('[competitor-reveal] build failed:', e);
      }
    });
  }

  // ─── 7. Share link (90-day TTL, same as paid shares) ────────────────
  const expiresAt = new Date(
    Date.now() + SHARE_LINK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: share, error: shareErr } = await supabase
    .from('scan_share_links')
    .insert({
      scan_id: scanResult.scanId,
      expires_at: expiresAt,
    })
    .select('id')
    .single<{ id: string }>();
  if (shareErr || !share) {
    return {
      ok: false,
      kind: 'db',
      message: `share link insert failed: ${shareErr?.message ?? 'no row'}`,
    };
  }

  return {
    ok: true,
    clientId: client.id,
    shareId: share.id,
    scanId: scanResult.scanId,
    turfScore: scanResult.turfScore,
  };
}
