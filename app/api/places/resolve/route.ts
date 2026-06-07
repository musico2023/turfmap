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
 * Auth: open. The endpoint is rate-limited at the network layer (Vercel
 * Functions throttle), and the response only echoes back PUBLIC Google
 * Place data — same surface anyone can pull from Maps directly. No
 * scraping advantage. The server-side GOOGLE_PLACES_API_KEY is never
 * exposed to the client; the browser sends the place_id and we do the
 * Place Details lookup with the existing helper.
 *
 * Cost: $0.017 per call (Place Details (New), Pro tier — same field
 * mask used everywhere else in lib/google/places.ts). Negligible at
 * lander volumes.
 *
 * Response shape mirrors the fields ScanIntakeForm needs:
 *   200 { ok: true, businessName, formattedAddress, latitude,
 *         longitude, phone, primaryType, placeId, addressComponents }
 *   400 invalid body
 *   404 place not found / API key missing
 *   502 Google API error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPlaceDetails } from '@/lib/google/places';

export const runtime = 'nodejs';

const Body = z.object({
  place_id: z.string().min(1).max(300),
});

export async function POST(req: Request) {
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
