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
};

export async function geocodeAddress(
  address: string
): Promise<GeocodeResult | null> {
  const trimmed = address.trim();
  if (trimmed.length < 4) return null;

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    addressdetails: '0',
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

  const json = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    importance?: number;
    boundingbox?: [string, string, string, string];
  }>;

  if (!json.length) return null;
  const r = json[0];

  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    display_name: r.display_name,
    importance: typeof r.importance === 'number' ? r.importance : 0,
    bbox: r.boundingbox
      ? (r.boundingbox.map((s) => Number(s)) as [number, number, number, number])
      : undefined,
  };
}
