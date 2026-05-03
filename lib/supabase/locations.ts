/**
 * Location resolution helpers for multi-location clients.
 *
 * After migration 0006, NAP fields + scan-grid coords + service radius
 * live on `client_locations`, not on `clients`. Code paths that
 * previously read from a clients row now resolve through one of these
 * helpers so they continue to work for both single-location and
 * multi-location clients.
 *
 * Resolution rules:
 *   - If a `locationId` is supplied, use that exact location (must
 *     belong to `clientId`, otherwise null).
 *   - Otherwise return the client's primary location.
 *   - If no location row exists at all (shouldn't happen post-migration
 *     0006 but defensive), return null. Caller decides how to fall back.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientLocationRow } from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

const LOCATION_COLS =
  'id, client_id, label, is_primary, address, street_address, city, region, postcode, country_code, phone, latitude, longitude, pin_lat, pin_lng, service_radius_miles, gbp_url, created_at';

/**
 * Returns the requested location, or — if `locationId` is null —
 * the client's primary location. Returns null when nothing matches.
 */
export async function resolveLocation(
  supabase: SupabaseLike,
  clientId: string,
  locationId: string | null | undefined
): Promise<ClientLocationRow | null> {
  if (locationId) {
    const { data } = await supabase
      .from('client_locations')
      .select(LOCATION_COLS)
      .eq('id', locationId)
      .eq('client_id', clientId)
      .maybeSingle<ClientLocationRow>();
    return data ?? null;
  }
  return await getPrimaryLocation(supabase, clientId);
}

/** The single is_primary=true location for this client. */
export async function getPrimaryLocation(
  supabase: SupabaseLike,
  clientId: string
): Promise<ClientLocationRow | null> {
  const { data } = await supabase
    .from('client_locations')
    .select(LOCATION_COLS)
    .eq('client_id', clientId)
    .eq('is_primary', true)
    .maybeSingle<ClientLocationRow>();
  return data ?? null;
}

/** All locations for a client, ordered with primary first. */
export async function listLocations(
  supabase: SupabaseLike,
  clientId: string
): Promise<ClientLocationRow[]> {
  const { data } = await supabase
    .from('client_locations')
    .select(LOCATION_COLS)
    .eq('client_id', clientId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .returns<ClientLocationRow[]>();
  return data ?? [];
}

/** Composes a freeform display label for the location: explicit label
 *  if set, otherwise city, otherwise the first line of the address. */
export function locationDisplayLabel(loc: ClientLocationRow): string {
  if (loc.label && loc.label.trim().length > 0) return loc.label;
  if (loc.city) return loc.city;
  if (loc.address) return loc.address.split(',')[0].trim();
  return 'Unnamed location';
}

/** True iff every BrightLocal-required NAP field is present. */
export function hasCompleteNapFields(loc: ClientLocationRow): boolean {
  return Boolean(
    loc.phone &&
      loc.street_address &&
      loc.city &&
      loc.region &&
      loc.postcode
  );
}
