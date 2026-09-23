/**
 * POST /api/places/resolve
 *
 * Score-funnel form helper. Takes a Google Place ID (selected from the
 * lander's PlaceAutocompleteElement) and returns a normalized payload
 * the form can use to pre-fill businessName + address + lat/lng +
 * phone state. This collapses what was previously 4-5 typed fields
 * (business name, street, city, region, phone) into ONE buyer action:
 * pick from the autocomplete dropdown.
 *
 * Auth: open, because the callers are public landers (the /score and
 * /free-score-now autocompletes) — there is no session to require. The
 * response only echoes PUBLIC Google Place data, so there's no scraping
 * advantage, and the server-side GOOGLE_PLACES_API_KEY is never exposed:
 * the browser sends a place_id and we do the lookup here.
 *
 * Cost: $0.017 per call (Place Details (New), Pro tier — the same field
 * mask used everywhere else in lib/google/places.ts). That is the reason
 * this route is rate-limited in-process. The previous note here claimed
 * it was "rate-limited at the network layer (Vercel Functions throttle)";
 * no such per-IP throttle exists, so an unauthenticated caller in a loop
 * was an uncapped charge on our Google account, not merely a scraper.
 *
 * Limit: PLACES_RESOLVE_MAX_PER_HOUR per IP. A buyer picking (and
 * re-picking) from the dropdown uses a handful; the cap bounds a runaway
 * caller to ~$0.60/hour/IP instead of unbounded.
 *
 * Response shape mirrors the fields ScanIntakeForm needs:
 *   200 { ok: true, businessName, formattedAddress, latitude,
 *         longitude, phone, primaryType, placeId, addressComponents }
 *   400 invalid body
 *   404 place not found / API key missing
 *   429 per-IP hourly cap exceeded
 *   502 Google API error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPlaceDetails } from '@/lib/google/places';
import { checkRateLimit, clientIpFromRequest } from '@/lib/security/rateLimit';

export const runtime = 'nodejs';

/** Generous for a human picking from a dropdown, tight against a loop.
 *  At $0.017/call this caps one IP at ~$0.60/hour. */
const PLACES_RESOLVE_MAX_PER_HOUR = 35;

const Body = z.object({
  place_id: z.string().min(1).max(300),
});

export async function POST(req: Request) {
  // Cap BEFORE parsing or calling Google — the spend is the thing being
  // protected, so a rejected caller must never reach getPlaceDetails.
  const ip = clientIpFromRequest(req);
  const limit = checkRateLimit('places_resolve', ip, {
    max: PLACES_RESOLVE_MAX_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many lookups from this network. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid body',
      },
      { status: 400 }
    );
  }

  const details = await getPlaceDetails(body.place_id);
  if (!details) {
    return NextResponse.json(
      { error: 'place not found or Google API unavailable' },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true,
    placeId: details.placeId,
    businessName: details.displayName,
    formattedAddress: details.formattedAddress,
    latitude: details.latitude,
    longitude: details.longitude,
    // Phone is the high-leverage win — Google has it for ~90% of
    // local businesses, and the buyer doesn't have to type it on
    // mobile. Falls back to empty string if Google doesn't have it,
    // and the form's phone field then stays empty (downstream Meta
    // CAPI accepts missing phone gracefully).
    phone: details.nationalPhoneNumber ?? '',
    primaryType: details.primaryType,
    // Structured components for downstream NAP enrichment +
    // ScanIntakeForm's existing `components` field on the submit
    // body. Matches the same shape that Mapbox's onSelect produces.
    addressComponents: details.addressComponents,
  });
}
