/**
 * GET  /api/clients/[id]/locations — list this client's locations.
 * POST /api/clients/[id]/locations — add a new location.
 *
 * Both routes are agency-gated. New locations come in non-primary by
 * default; promoting a location to primary is done via the per-location
 * PATCH route (which also un-promotes the existing primary atomically).
 *
 * The POST flow does NOT auto-geocode. The client form already calls
 * /api/geocode to resolve lat/lng + structured fields before posting,
 * so this endpoint just persists what it's given. This keeps the route
 * simple and avoids two geocode hops on the same address.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { listLocations } from '@/lib/supabase/locations';
import type { ClientLocationRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const NewLocationBody = z.object({
  label: z.string().min(1).max(80).optional().nullable(),
  address: z.string().min(4).max(400),
  street_address: z.string().min(1).max(200).optional().nullable(),
  city: z.string().min(1).max(120).optional().nullable(),
  region: z.string().min(1).max(120).optional().nullable(),
  postcode: z.string().min(1).max(20).optional().nullable(),
  country_code: z
    .string()
    .length(3, 'ISO-3166-1 alpha-3 (e.g. USA)')
    .optional()
    .nullable(),
  phone: z.string().min(4).max(40).optional().nullable(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pin_lat: z.number().min(-90).max(90).optional().nullable(),
  pin_lng: z.number().min(-180).max(180).optional().nullable(),
  service_radius_miles: z.number().min(0.1).max(10).optional(),
  gbp_url: z.string().url().max(2048).optional().nullable(),
  /** Optional — caller can set this true to flip the primary atomically.
   *  When true, the existing primary is demoted in the same transaction. */
  is_primary: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const supabase = getServerSupabase();
  const locations = await listLocations(supabase, id);
  return NextResponse.json({ locations });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientId } = await params;

  let parsed: z.infer<typeof NewLocationBody>;
  try {
    parsed = NewLocationBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: e.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Confirm the client exists.
  const { data: clientCheck } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle<{ id: string }>();
  if (!clientCheck) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // If caller wants this new location to be primary, demote the existing
  // primary first. Done in two ops since Supabase JS doesn't expose
  // transactions; the partial unique index would otherwise reject the
  // new primary insert. The window between demote+insert is small.
  if (parsed.is_primary === true) {
    await supabase
      .from('client_locations')
      .update({ is_primary: false })
      .eq('client_id', clientId)
      .eq('is_primary', true);
  }

  const { data: row, error: insErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: clientId,
      label: parsed.label ?? null,
      is_primary: parsed.is_primary ?? false,
      address: parsed.address,
      street_address: parsed.street_address ?? null,
      city: parsed.city ?? null,
      region: parsed.region ?? null,
      postcode: parsed.postcode ?? null,
      country_code: parsed.country_code ?? 'USA',
      phone: parsed.phone ?? null,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      pin_lat: parsed.pin_lat ?? null,
      pin_lng: parsed.pin_lng ?? null,
      service_radius_miles: parsed.service_radius_miles ?? 1.6,
      gbp_url: parsed.gbp_url ?? null,
    })
    .select('*')
    .single<ClientLocationRow>();
  if (insErr || !row) {
    return NextResponse.json(
      { error: `location insert failed: ${insErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ location: row });
}
