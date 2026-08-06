/**
 * Persistence orchestration for Google Places enrichment.
 *
 * Wraps lib/google/places.ts with the DB writes against
 * client_locations.google_place_id and the gbp_signals table.
 *
 * Two entrypoints:
 *   - enrichLocationFromOnboarding(): one-shot at create time. Looks
 *     up the place via Find-then-Verify, stores place_id + initial
 *     Pro snapshot, returns a status object. Soft-fail on every
 *     branch — never throws into the onboarding flow.
 *   - refreshLocationSignals(): used by the weekly cron. Skips
 *     locations without a stored place_id. Inserts a fresh
 *     gbp_signals row.
 *
 * Both entrypoints are no-ops when GOOGLE_PLACES_API_KEY isn't
 * configured (lib/google/places.ts soft-fails to null).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findAndVerifyPlace, getPlaceDetails, type PlaceDetails } from './places';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type OnboardingEnrichmentStatus =
  | {
      status: 'matched';
      placeId: string;
      signalsId: string;
      costCents: number;
      matchDistanceM: number;
      matchNameSimilarity: number;
    }
  | { status: 'no_match'; costCents: number }
  | { status: 'skipped'; reason: 'no_api_key' | 'missing_inputs' | 'error' };

export type GbpMatchStatus =
  | 'auto'
  | 'confirmed'
  | 'manual'
  | 'rejected'
  | 'no_match';

/** ISO-3166 alpha-3 (our storage format) → the country word DFS expects
 *  in its "City,Region,Country" location_name string. */
const DFS_COUNTRY_WORD: Record<string, string> = {
  USA: 'United States',
  CAN: 'Canada',
  GBR: 'United Kingdom',
  AUS: 'Australia',
};

/**
 * Build DFS's "City,Region,Country" location string for a stored
 * location, or null when the row lacks a city (the fallback is
 * city-scoped, so without one we'd be guessing).
 */
async function buildDfsLocationName(
  supabase: SupabaseLike,
  locationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('client_locations')
    .select('city, region, country_code')
    .eq('id', locationId)
    .maybeSingle<{
      city: string | null;
      region: string | null;
      country_code: string | null;
    }>();
  const city = data?.city?.trim();
  const region = data?.region?.trim();
  if (!city || !region) return null;
  const country = DFS_COUNTRY_WORD[(data?.country_code ?? 'USA').toUpperCase()];
  if (!country) return null;
  return `${city},${region},${country}`;
}

/**
 * Look up the GBP listing for a freshly-created location and persist
 * place_id + initial signals. Designed for fire-and-forget use from
 * onboarding routes — never throws.
 */
export async function enrichLocationFromOnboarding(
  supabase: SupabaseLike,
  args: {
    locationId: string;
    businessName: string;
    latitude: number | null;
    longitude: number | null;
  }
): Promise<OnboardingEnrichmentStatus> {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { status: 'skipped', reason: 'no_api_key' };
  }
  if (
    args.latitude === null ||
    args.longitude === null ||
    !args.businessName.trim()
  ) {
    return { status: 'skipped', reason: 'missing_inputs' };
  }

  // City/region for the service-area fallback inside findAndVerifyPlace.
  // Read here rather than threaded through every caller — the location row
  // is already the source of truth and all three onboarding entrypoints
  // have written it by the time this fires.
  const dfsLocationName = await buildDfsLocationName(supabase, args.locationId);

  let result: Awaited<ReturnType<typeof findAndVerifyPlace>>;
  try {
    result = await findAndVerifyPlace({
      businessName: args.businessName,
      latitude: args.latitude,
      longitude: args.longitude,
      dfsLocationName,
    });
  } catch (e) {
    console.warn('[places.enrich] findAndVerifyPlace threw', e);
    return { status: 'skipped', reason: 'error' };
  }

  if (!result) {
    // Mark the location as 'no_match' so the AI Coach skips signals
    // and the backfill / cron skip future re-tries. The Text Search
    // call still cost ~0.5¢; we accept that as cost-of-onboarding.
    await supabase
      .from('client_locations')
      .update({
        google_place_match_status: 'no_match',
        google_place_id: null,
      })
      .eq('id', args.locationId);
    return { status: 'no_match', costCents: 1 };
  }

  // Persist place_id + match metadata on the location row. Status
  // 'auto' means strict-match passed but operator hasn't reviewed
  // yet — the AI Coach treats it as usable, but the locations
  // panel surfaces a "confirm/reject" badge.
  const { error: locErr } = await supabase
    .from('client_locations')
    .update({
      google_place_id: result.details.placeId,
      google_place_match_status: 'auto',
      google_place_match_distance_m: Math.round(result.matchDistanceM),
      google_place_match_name_similarity: Number(
        result.matchNameSimilarity.toFixed(2)
      ),
    })
    .eq('id', args.locationId);
  if (locErr) {
    console.warn('[places.enrich] failed to persist place_id', locErr.message);
    return { status: 'skipped', reason: 'error' };
  }

  // Persist initial signals snapshot.
  const signalsId = await insertSignalsRow(
    supabase,
    args.locationId,
    result.details
  );
  if (!signalsId) return { status: 'skipped', reason: 'error' };

  return {
    status: 'matched',
    placeId: result.details.placeId,
    signalsId,
    costCents: result.totalCostCents,
    matchDistanceM: result.matchDistanceM,
    matchNameSimilarity: result.matchNameSimilarity,
  };
}

/**
 * Confirm/reject helpers used by the operator UI. Always update the
 * status column so the Coach + cron can act consistently.
 */
export async function confirmMatch(
  supabase: SupabaseLike,
  locationId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('client_locations')
    .update({ google_place_match_status: 'confirmed' })
    .eq('id', locationId);
  return !error;
}

export async function rejectMatch(
  supabase: SupabaseLike,
  locationId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('client_locations')
    .update({
      google_place_match_status: 'rejected',
      google_place_id: null,
      google_place_match_distance_m: null,
      google_place_match_name_similarity: null,
    })
    .eq('id', locationId);
  return !error;
}

/**
 * Operator-driven manual selection. Stores the picked place_id with
 * status='manual' and triggers an immediate Place Details fetch so
 * the next AI Coach run has signals to cite. Returns true on success.
 */
export async function selectMatchManually(
  supabase: SupabaseLike,
  args: { locationId: string; placeId: string }
): Promise<boolean> {
  const details = await getPlaceDetails(args.placeId);
  if (!details) return false;
  const { error } = await supabase
    .from('client_locations')
    .update({
      google_place_id: args.placeId,
      google_place_match_status: 'manual',
      // Operator-confirmed selection — the auto-strict-match metrics
      // don't apply here. Null them out so the audit trail reads as
      // "manually picked" rather than "passed strict match".
      google_place_match_distance_m: null,
      google_place_match_name_similarity: null,
    })
    .eq('id', args.locationId);
  if (error) return false;
  await insertSignalsRow(supabase, args.locationId, details);
  return true;
}

/**
 * Cron entrypoint — refreshes signals for one location. Returns the
 * cost cents on success (so the cron can aggregate), or null on
 * skip/failure.
 */
export async function refreshLocationSignals(
  supabase: SupabaseLike,
  args: { locationId: string; placeId: string }
): Promise<number | null> {
  if (!process.env.GOOGLE_PLACES_API_KEY) return null;
  let details: PlaceDetails | null;
  try {
    details = await getPlaceDetails(args.placeId);
  } catch (e) {
    console.warn('[places.enrich] getPlaceDetails threw', e);
    return null;
  }
  if (!details) return null;
  const signalsId = await insertSignalsRow(supabase, args.locationId, details);
  if (!signalsId) return null;
  return details.costCents;
}

async function insertSignalsRow(
  supabase: SupabaseLike,
  locationId: string,
  d: PlaceDetails
): Promise<string | null> {
  const { data, error } = await supabase
    .from('gbp_signals')
    .insert({
      client_location_id: locationId,
      rating: d.rating,
      user_ratings_total: d.userRatingCount,
      primary_type: d.primaryType,
      types: d.types,
      business_status: d.businessStatus,
      phone_number: d.nationalPhoneNumber,
      website_uri: d.websiteUri,
      photos_count: d.photosCount,
      price_level: d.priceLevel,
      editorial_summary: d.editorialSummary,
      regular_opening_hours: d.regularOpeningHours,
      fetch_cost_cents: d.costCents,
      raw: d.raw,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !data) {
    console.warn(
      '[places.enrich] failed to insert gbp_signals',
      error?.message
    );
    return null;
  }
  return data.id;
}

/**
 * Read helper for the AI Coach prompt. Returns the latest signals row
 * for a location (by fetched_at desc) or null when none exists.
 */
export async function getLatestSignals(
  supabase: SupabaseLike,
  locationId: string
): Promise<GbpSignalsRow | null> {
  const { data } = await supabase
    .from('gbp_signals')
    .select(
      'id, client_location_id, rating, user_ratings_total, primary_type, types, business_status, phone_number, website_uri, photos_count, price_level, editorial_summary, regular_opening_hours, fetch_cost_cents, fetched_at'
    )
    .eq('client_location_id', locationId)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle<GbpSignalsRow>();
  return data ?? null;
}

export type GbpSignalsRow = {
  id: string;
  client_location_id: string;
  rating: number | null;
  user_ratings_total: number | null;
  primary_type: string | null;
  types: string[] | null;
  business_status: string | null;
  phone_number: string | null;
  website_uri: string | null;
  photos_count: number | null;
  price_level: string | null;
  editorial_summary: string | null;
  regular_opening_hours: unknown | null;
  fetch_cost_cents: number | null;
  fetched_at: string;
};
