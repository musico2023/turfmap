/**
 * Nominatim (OpenStreetMap) geocoding wrapper.
 *
 * Free, no API key required. Usage policy:
 *   https://operations.osmfoundation.org/policies/nominatim/
 *   - Max 1 req/sec
 *   - A User-Agent identifying the application (with contact email) is required
 *   - Cache results; don't hammer the service
 *
 * For TurfMap's needs (one geocode per client onboarded, low volume) this
 * fits squarely inside the policy. If we ever need higher throughput,
 * swap for Mapbox/Google by changing this single file.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
// Identifies our app to OSM operators per their policy. Include a contact
// email so they can reach out before banning if usage spikes.
const USER_AGENT = 'TurfMap.ai/1.0 (https://turfmap.ai; anthony@fourdots.io)';

export type GeocodeResult = {
  lat: number;
  lng: number;
  /** Nominatim's canonical formatted address. */
  display_name: string;
  /** Confidence-ish — Nominatim's importance score, 0..1. */
  importance: number;
  /** Bounding box [south, north, west, east] in degrees. */
  bbox?: [number, number, number, number];
  /** Parsed components — used to pre-fill the structured NAP fields on
   *  the client form so operators don't have to type the address twice. */
  components?: {
    /** "house_number road", e.g. "100 Queen Street West". */
    street_address: string | null;
    /** city / town / village / hamlet / suburb — first one Nominatim returns. */
    city: string | null;
    /** Full state/province name (e.g. "Ontario"). Nominatim doesn't provide
     *  the 2-letter code; the operator can shorten if needed. */
    region: string | null;
    postcode: string | null;
    /** ISO-3166-1 alpha-3 (e.g. "USA"). Mapped from Nominatim's alpha-2.
     *  Falls back to uppercase alpha-2 when no mapping exists — BrightLocal
     *  rejects unknowns; operator can edit on the form. */
    country_code: string | null;
  };
};

// Common alpha-2 → alpha-3 country codes for TurfMap's expected markets.
// BrightLocal Listings API requires alpha-3.
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  us: 'USA',
  ca: 'CAN',
  gb: 'GBR',
  au: 'AUS',
  nz: 'NZL',
  ie: 'IRL',
};

export async function geocodeAddress(
  address: string
): Promise<GeocodeResult | null> {
  const trimmed = address.trim();
  if (trimmed.length < 4) return null;

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    // 1 = include the structured `address` object (street, city, state,
    // postcode, country, country_code). Used to pre-fill the NAP fields.
    addressdetails: '1',
    limit: '1',
  });
  const url = `${NOMINATIM_BASE}/search?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    // Nominatim explicitly asks consumers not to disable browser caching.
    // Next's default is fine; force a short revalidation window so repeated
    // typos in the onboarding flow don't hammer them.
    next: { revalidate: 60 * 60 * 24 },
  });

  if (!res.ok) {
    throw new Error(`Nominatim HTTP ${res.status}`);
  }

  type NominatimAddress = {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    suburb?: string;
    state?: string;
    state_district?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  };
  const json = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    importance?: number;
    boundingbox?: [string, string, string, string];
    address?: NominatimAddress;
  }>;

  if (!json.length) return null;
  const r = json[0];

  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const a = r.address ?? {};
  const street = [a.house_number, a.road ?? a.pedestrian]
    .filter(Boolean)
    .join(' ')
    .trim();
  // City fallbacks: cities use 'city', suburbs use 'suburb', rural areas
  // use 'town'/'village'/'hamlet'. Pick the most populated unit available.
  const city =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? null;
  const region = a.state ?? a.state_district ?? null;
  const postcode = a.postcode ?? null;
  const cc2 = (a.country_code ?? '').toLowerCase();
  const country_code =
    ALPHA2_TO_ALPHA3[cc2] ?? (cc2 ? cc2.toUpperCase() : null);

  return {
    lat,
    lng,
    display_name: r.display_name,
    importance: typeof r.importance === 'number' ? r.importance : 0,
    bbox: r.boundingbox
      ? (r.boundingbox.map((s) => Number(s)) as [number, number, number, number])
      : undefined,
    components: {
      street_address: street.length > 0 ? street : null,
      city,
      region,
      postcode,
      country_code,
    },
  };
}
