/**
 * POST /api/geocode — server-side geocoding for the onboarding form.
 *
 * Agency-gated (the address is benign, but exposing an unauthenticated
 * proxy to Nominatim could get our IP banned). Returns the first hit, or
 * a friendly error if Nominatim doesn't recognize the address.
 *
 * Body:    { address: string }
 * Returns: { lat, lng, formatted, components } | { error }
 *   components: structured fields parsed from Nominatim — used to
 *   pre-fill the BrightLocal NAP section on the create form so
 *   operators don't type the address twice.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { geocodeAddress } from '@/lib/geocoding/nominatim';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

const Body = z.object({
  address: z.string().min(4).max(400),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await geocodeAddress(parsed.address);
    // Nominatim is finicky about postal codes — if the operator typed
    // a "1440 Bathurst, Toronto, ON M5R 3J3" style address and Nominatim
    // returns nothing, retry with the postal code stripped. Most
    // operators don't realize their postcode is what broke the lookup,
    // so falling back silently is much better UX than surfacing a
    // "couldn't find" error and forcing them to retry by hand.
    if (!result) {
      const stripped = stripPostalCode(parsed.address);
      if (stripped !== parsed.address) {
        result = await geocodeAddress(stripped);
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: `geocoding failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  if (!result) {
    return NextResponse.json(
      {
        error:
          "couldn't find that address — try removing the postal code, adding city/state, or entering coordinates manually",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    lat: result.lat,
    lng: result.lng,
    formatted: result.display_name,
    components: result.components ?? null,
  });
}

/**
 * Strip the most common postal-code formats from a free-text address.
 * Used as a fallback when Nominatim returns no results — postal codes
 * are the #1 cause of false negatives because Nominatim's index of
 * Canadian/UK postcodes is incomplete and a wrong postcode can make
 * a perfectly valid street+city query return zero hits.
 *
 * Recognized:
 *   - Canadian:   K1A 0B1, K1A0B1 (with or without space)
 *   - US ZIP:     12345 or 12345-6789
 *   - UK:         SW1A 1AA, EC1A 1BB (with or without space)
 *
 * Returns the input unchanged if no postal-code-like pattern matches —
 * caller checks `stripped !== input` to decide whether to retry.
 */
function stripPostalCode(address: string): string {
  return address
    .replace(/\b[A-Z]\d[A-Z][\s-]?\d[A-Z]\d\b/gi, '') // Canada: A1A 1A1
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '') // US ZIP / ZIP+4
    .replace(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/gi, '') // UK
    .replace(/[,\s]+,/g, ',') // collapse "  ,  ," runs left behind
    .replace(/,\s*$/, '') // trailing comma cleanup
    .replace(/\s{2,}/g, ' ') // collapse double spaces
    .trim();
}
