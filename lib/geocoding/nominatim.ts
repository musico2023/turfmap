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

/** ISO 3166-1 alpha-2 codes Nominatim accepts in its `countrycodes`
 *  filter. Mirrors AddressAutocomplete's Mapbox `countries` default of
 *  US + CA so the freeform-fallback path doesn't produce surprises
 *  like "1 Wexford Road" resolving to Auckland, NZ (which happened to
 *  D Spot Brampton Wexford on 2026-05-15 — the operator picked from
 *  Mapbox but then edited the input, falling back to this geocoder,
 *  which had no country filter at the time). */
const DEFAULT_COUNTRIES = 'ca,us';

/** Structured-search hints the caller can supply alongside (or
 *  instead of) the freeform address string. When ANY of these are
 *  provided we issue a STRUCTURED Nominatim query instead of a
 *  free-text `q=` search — much more accurate disambiguation.
 *
 *  Background: with free-text search, Nominatim ranks results by an
 *  internal "importance" score that's biased toward larger /
 *  better-known places. "1051 Southfield Drive, Plainfield IN 46168"
 *  free-text-resolved to a same-named street in Auburn, IN
 *  (2026-05-19 Hendricks Behavioral Hospital incident) because the
 *  importance score favored that match. With structured params
 *  (`street=1051 Southfield Drive&city=Plainfield&state=Indiana&
 *  postalcode=46168`) Nominatim respects the supplied
 *  disambiguators and returns the operator's actual address.
 *
 *  All fields optional individually. Caller decides which to send
 *  based on what data they have (e.g., Mapbox autocomplete gives all
 *  four cleanly; a freeform paste might only have city + region). */
export type GeocodeHints = {
  street?: string | null;
  city?: string | null;
  /** State / province. Accepts full name ("Indiana") or 2-letter
   *  abbreviation ("IN") — Nominatim is forgiving on both. */
  state?: string | null;
  postalcode?: string | null;
};

export async function geocodeAddress(
  address: string,
  options: { countries?: string; hints?: GeocodeHints } = {}
): Promise<GeocodeResult | null> {
  const trimmed = address.trim();
  if (trimmed.length < 4) return null;

  // Decide search strategy: structured (when any hint provided) vs
  // free-text (back-compat default). Structured search dramatically
  // improves accuracy for ambiguous street names — see GeocodeHints
  // docstring for the Hendricks incident rationale.
  const hints = options.hints ?? {};
  const hasHints = Boolean(
    hints.street || hints.city || hints.state || hints.postalcode
  );

  const params = new URLSearchParams({
    format: 'jsonv2',
    // 1 = include the structured `address` object (street, city, state,
    // postcode, country, country_code). Used to pre-fill the NAP fields.
    addressdetails: '1',
    limit: '1',
    // Country restriction — Nominatim accepts comma-separated alpha-2
    // codes. Defaults to US+CA (TurfMap's primary book) but callers
    // can override via the options arg for niche cases.
    countrycodes: (options.countries ?? DEFAULT_COUNTRIES).toLowerCase(),
  });

  if (hasHints) {
    // Structured search — Nominatim merges these into a high-precision
    // lookup. Empty fields are dropped to keep the query lean.
    if (hints.street) params.set('street', hints.street);
    if (hints.city) params.set('city', hints.city);
    if (hints.state) params.set('state', hints.state);
    if (hints.postalcode) params.set('postalcode', hints.postalcode);
  } else {
    // Back-compat: free-text query when no hints. Used by callers
    // that only have a single-line address string.
    params.set('q', trimmed);
  }

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
