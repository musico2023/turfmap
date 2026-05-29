/**
 * Google Places (New) API client.
 *
 * All Places-API calls in TurfMap MUST go through this module so cost
 * tracking and the strict-match guardrail stay centralized.
 *
 * Pricing (per Google's SKU pricing, Places API New):
 *   - Text Search (Essentials, id-only):      $5  / 1k = $0.005
 *   - Place Details (Pro, fields below):     $20  / 1k = $0.020
 *   Onboarding (one-time per location): ~$0.025 (Find + initial Pro fetch)
 *   Weekly refresh per location:        ~$0.020 (Pro fetch only)
 *
 * Strict-match guardrail:
 *   We never store an uncertain place_id. After Text Search returns a
 *   candidate, we verify:
 *     1) Distance from our geocoded coords < MATCH_RADIUS_M
 *     2) Name token similarity (Jaccard) >= MATCH_NAME_SIMILARITY
 *   If either fails, we return null and the caller stores no place_id.
 *   Better no GBP signals than wrong-business signals.
 *
 * Soft-fail:
 *   If GOOGLE_PLACES_API_KEY isn't configured, every entrypoint returns
 *   null without throwing. Onboarding flows continue working in dev
 *   environments without the key.
 */

const PLACES_BASE = 'https://places.googleapis.com/v1';

/** Strict-match thresholds — see module docstring. */
const MATCH_RADIUS_M = 100;
const MATCH_NAME_SIMILARITY = 0.5;

/**
 * Field mask for Place Details (Pro tier). Driven by what the AI Coach
 * prompt actually consumes — narrower than the full Pro field list to
 * keep response payloads small. Pricing is determined by the highest
 * tier field requested, not the count.
 */
const PLACE_DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  // addressComponents — added to support audit-time NAP-field
  // enrichment for cold-prospect comp audits. The fan-out used to
  // grab only formattedAddress; structured components let us stamp
  // client_locations.street_address / city / region / postcode
  // directly without regex-parsing the freeform string.
  'addressComponents',
  'location',
  'types',
  'primaryType',
  'businessStatus',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'nationalPhoneNumber',
  'websiteUri',
  'photos',
  'priceLevel',
  'editorialSummary',
].join(',');

/** Cost in cents per call type — surfaced to callers for dfs-cost-style tracking. */
const COST_CENTS = {
  textSearchEssentials: 1, // 0.5¢ rounded up
  placeDetailsPro: 2, // 2¢
} as const;

export type FindPlaceResult = {
  placeId: string;
  costCents: number;
};

export type SearchCandidate = {
  placeId: string;
  displayName: string | null;
  formattedAddress: string | null;
  primaryType: string | null;
  rating: number | null;
  userRatingCount: number | null;
};

/** Parsed-out structured address fields the NAP audit + dashboard
 *  need. Derived from Google's addressComponents on getPlaceDetails;
 *  all fields nullable because Google occasionally returns partial
 *  components (rural addresses sometimes lack postal_code, etc.). */
export type PlaceAddressComponents = {
  streetAddress: string | null; // "123 Main St"
  city: string | null;
  region: string | null; // state / province short_name (e.g. "ON")
  postcode: string | null;
  countryCode: string | null; // ISO short_name (e.g. "CA", "US")
};

export type PlaceDetails = {
  placeId: string;
  displayName: string | null;
  formattedAddress: string | null;
  /** Parsed-out structured components — populated when Google
   *  returns addressComponents on the details response. Used by
   *  the audit-init NAP-field enrichment path to stamp
   *  client_locations.street_address / city / region / postcode. */
  addressComponents: PlaceAddressComponents | null;
  latitude: number | null;
  longitude: number | null;
  primaryType: string | null;
  types: string[];
  businessStatus: string | null;
  rating: number | null;
  userRatingCount: number | null;
  regularOpeningHours: unknown | null;
  nationalPhoneNumber: string | null;
  websiteUri: string | null;
  photosCount: number | null;
  priceLevel: string | null;
  editorialSummary: string | null;
  raw: unknown;
  costCents: number;
};

function apiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

/**
 * Text Search → place_id only (Essentials tier). Returns the top
 * candidate's id within `locationBias`; `null` if zero results or
 * the API key isn't configured.
 */
async function textSearchTopId(
  query: string,
  lat: number,
  lng: number,
  radiusM: number = 200
): Promise<{ placeId: string | null; costCents: number }> {
  const key = apiKey();
  if (!key) return { placeId: null, costCents: 0 };
  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id',
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusM },
      },
      maxResultCount: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[places] textSearch failed', res.status, text.slice(0, 200));
    return { placeId: null, costCents: 0 };
  }
  const data = (await res.json()) as { places?: { id?: string }[] };
  const placeId = data.places?.[0]?.id ?? null;
  return { placeId, costCents: placeId ? COST_CENTS.textSearchEssentials : 0 };
}

/**
 * Multi-result Text Search for the manual-override flow. Returns up
 * to N candidates with enough surface info (name, address, category,
 * rating) for the operator to pick the right listing. Pricing tier
 * is Pro because we ask for rating + types in the field mask.
 */
export async function searchPlaces(input: {
  query: string;
  latitude: number | null;
  longitude: number | null;
  maxResults?: number;
  /** ISO-3166-1 alpha-2 region bias. Without lat/lng, the Places API
   *  global text search is too noisy to find small local businesses
   *  by name alone — a country bias dramatically improves recall.
   *  Defaults to 'CA' since Fourdots' lead pool is mostly Canadian;
   *  callers with a known US-only segment can override. */
  regionCode?: string | null;
}): Promise<{ candidates: SearchCandidate[]; costCents: number }> {
  const key = apiKey();
  if (!key) return { candidates: [], costCents: 0 };
  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.primaryType',
    'places.rating',
    'places.userRatingCount',
  ].join(',');
  const body: Record<string, unknown> = {
    textQuery: input.query,
    maxResultCount: Math.min(input.maxResults ?? 5, 10),
  };
  if (input.latitude !== null && input.longitude !== null) {
    body.locationBias = {
      circle: {
        center: { latitude: input.latitude, longitude: input.longitude },
        radius: 5000, // 5km — wider than auto-match radius for manual hunt
      },
    };
  } else if (input.regionCode !== null) {
    // No lat/lng → fall back to country bias. 'CA' default.
    body.regionCode = input.regionCode ?? 'CA';
  }
  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[places] searchPlaces failed', res.status, text.slice(0, 200));
    return { candidates: [], costCents: 0 };
  }
  type RawPlace = {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    primaryType?: string;
    rating?: number;
    userRatingCount?: number;
  };
  const data = (await res.json()) as { places?: RawPlace[] };
  const candidates: SearchCandidate[] = (data.places ?? [])
    .filter((p): p is RawPlace & { id: string } => typeof p.id === 'string')
    .map((p) => ({
      placeId: p.id,
      displayName: p.displayName?.text ?? null,
      formattedAddress: p.formattedAddress ?? null,
      primaryType: p.primaryType ?? null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      userRatingCount:
        typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    }));
  // Pro tier — searchPlaces with rating/types in the mask costs $32/1k
  // ≈ $0.032 = 3¢. Round up to be safe; surfaced for cost tracking.
  return { candidates, costCents: candidates.length > 0 ? 3 : 0 };
}

/**
 * Place Details (Pro tier). Returns the typed snapshot used by both
 * the strict-match check (during onboarding) and the gbp_signals
 * weekly refresh.
 */
export async function getPlaceDetails(
  placeId: string
): Promise<PlaceDetails | null> {
  const key = apiKey();
  if (!key) return null;
  const res = await fetch(
    `${PLACES_BASE}/places/${encodeURIComponent(placeId)}`,
    {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
      },
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[places] details failed', res.status, text.slice(0, 200));
    return null;
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const loc = raw.location as
    | { latitude?: number; longitude?: number }
    | undefined;
  const displayName = raw.displayName as { text?: string } | undefined;
  const editorial = raw.editorialSummary as { text?: string } | undefined;
  const photos = raw.photos as unknown[] | undefined;
  const types = (raw.types as string[] | undefined) ?? [];
  return {
    placeId,
    displayName: displayName?.text ?? null,
    formattedAddress: (raw.formattedAddress as string | undefined) ?? null,
    addressComponents: parseAddressComponents(
      raw.addressComponents as Array<{
        longText?: string;
        shortText?: string;
        types?: string[];
      }> | undefined
    ),
    latitude: typeof loc?.latitude === 'number' ? loc.latitude : null,
    longitude: typeof loc?.longitude === 'number' ? loc.longitude : null,
    primaryType: (raw.primaryType as string | undefined) ?? null,
    types,
    businessStatus: (raw.businessStatus as string | undefined) ?? null,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    userRatingCount:
      typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
    regularOpeningHours: (raw.regularOpeningHours as unknown) ?? null,
    nationalPhoneNumber:
      (raw.nationalPhoneNumber as string | undefined) ?? null,
    websiteUri: (raw.websiteUri as string | undefined) ?? null,
    photosCount: Array.isArray(photos) ? photos.length : null,
    priceLevel: (raw.priceLevel as string | undefined) ?? null,
    editorialSummary: editorial?.text ?? null,
    raw,
    costCents: COST_CENTS.placeDetailsPro,
  };
}

/**
 * Onboarding flow: Text Search → strict match → Place Details.
 * Returns the verified place + initial Pro snapshot, or null when
 * the match guardrail rejects the candidate (or the API key isn't
 * configured).
 *
 * Caller is responsible for persisting:
 *   - `client_locations.google_place_id = result.details.placeId`
 *   - A new `gbp_signals` row built from `result.details`
 *   - Cost cents accumulated on the client (or wherever you track).
 */
export async function findAndVerifyPlace(input: {
  businessName: string;
  latitude: number;
  longitude: number;
}): Promise<{
  details: PlaceDetails;
  matchDistanceM: number;
  matchNameSimilarity: number;
  totalCostCents: number;
} | null> {
  const search = await textSearchTopId(
    input.businessName,
    input.latitude,
    input.longitude,
    MATCH_RADIUS_M * 2 // search a slightly wider bias than match radius
  );
  if (!search.placeId) return null;

  const details = await getPlaceDetails(search.placeId);
  if (!details) return null;

  const totalCostCents = search.costCents + details.costCents;

  // Strict match: distance + name similarity. Reject otherwise.
  const matchDistanceM =
    details.latitude !== null && details.longitude !== null
      ? haversineMeters(
          { lat: input.latitude, lng: input.longitude },
          { lat: details.latitude, lng: details.longitude }
        )
      : Number.POSITIVE_INFINITY;
  const matchNameSimilarity = jaccardTokenSimilarity(
    input.businessName,
    details.displayName ?? details.formattedAddress ?? ''
  );

  if (
    matchDistanceM > MATCH_RADIUS_M ||
    matchNameSimilarity < MATCH_NAME_SIMILARITY
  ) {
    console.warn(
      `[places] match rejected for "${input.businessName}" — dist=${matchDistanceM.toFixed(0)}m sim=${matchNameSimilarity.toFixed(2)} (place=${details.displayName ?? details.placeId})`
    );
    return null;
  }

  return { details, matchDistanceM, matchNameSimilarity, totalCostCents };
}

// ─── helpers ────────────────────────────────────────────────────────────

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000; // Earth radius m
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const NAME_NOISE = new Set([
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'group',
  'the',
  'and',
  '&',
  'a',
  'of',
]);

function normalizedTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !NAME_NOISE.has(t))
  );
}

function jaccardTokenSimilarity(a: string, b: string): number {
  const A = normalizedTokens(a);
  const B = normalizedTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Parse Google Places addressComponents[] into the structured shape
 * the NAP audit + client_locations table expect. Returns null when
 * no usable components were returned (the helper falls back to
 * formattedAddress in that case).
 *
 * Component type semantics:
 *   - street_number + route   → streetAddress
 *   - locality | postal_town  → city
 *   - administrative_area_level_1 → region (shortText for state code)
 *   - postal_code             → postcode
 *   - country                 → countryCode (shortText, ISO alpha-2)
 *
 * Some components carry multiple types; we look for the first match
 * and use the type-appropriate length (long for street names, short
 * for state / country codes). Defensive parsing — every field is
 * nullable so a partial Google response doesn't collapse the result.
 */
function parseAddressComponents(
  components:
    | Array<{ longText?: string; shortText?: string; types?: string[] }>
    | undefined
): PlaceAddressComponents | null {
  if (!components || components.length === 0) return null;
  const findOf = (
    typeName: string,
    field: 'longText' | 'shortText' = 'longText'
  ): string | null => {
    const c = components.find((c) => (c.types ?? []).includes(typeName));
    return (c?.[field] ?? null) || null;
  };
  const streetNumber = findOf('street_number');
  const route = findOf('route');
  const streetAddress =
    [streetNumber, route].filter(Boolean).join(' ') || null;
  // City: prefer locality, fall back to postal_town (used in some
  // UK / Commonwealth markets where locality is set to the
  // sub-locality instead).
  const city = findOf('locality') ?? findOf('postal_town');
  const region = findOf('administrative_area_level_1', 'shortText');
  const postcode = findOf('postal_code');
  const countryCode = findOf('country', 'shortText');
  // If nothing parsed, return null so the caller can fall back to
  // formattedAddress string parsing.
  if (!streetAddress && !city && !region && !postcode && !countryCode) {
    return null;
  }
  return { streetAddress, city, region, postcode, countryCode };
}

export const __test = {
  haversineMeters,
  normalizedTokens,
  jaccardTokenSimilarity,
  parseAddressComponents,
  MATCH_RADIUS_M,
  MATCH_NAME_SIMILARITY,
  COST_CENTS,
};
