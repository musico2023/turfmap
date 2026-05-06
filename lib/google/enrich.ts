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
  | { status: 'matched'; placeId: string; signalsId: string; costCents: number }
  | { status: 'no_match'; costCents: number }
  | { status: 'skipped'; reason: 'no_api_key' | 'missing_inputs' | 'error' };

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

  let result: Awaited<ReturnType<typeof findAndVerifyPlace>>;
  try {
    result = await findAndVerifyPlace({
      businessName: args.businessName,
      latitude: args.latitude,
      longitude: args.longitude,
    });
  } catch (e) {
    console.warn('[places.enrich] findAndVerifyPlace threw', e);
    return { status: 'skipped', reason: 'error' };
  }

  if (!result) {
    // Soft-tracked: the Text Search call still cost money even on
    // rejected matches. We don't have a great place to attribute that
    // 0.5¢ to — we accept it as a cost-of-onboarding rounding error.
    return { status: 'no_match', costCents: 1 };
  }

  // Persist place_id on the location row.
  const { error: locErr } = await supabase
    .from('client_locations')
    .update({ google_place_id: result.details.placeId })
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
  };
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
