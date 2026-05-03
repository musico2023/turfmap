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
          "couldn't find that address — try adding city/state, or enter coordinates manually",
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
