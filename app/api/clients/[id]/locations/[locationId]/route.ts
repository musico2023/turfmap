/**
 * PATCH  /api/clients/[id]/locations/[locationId] — partial update.
 * DELETE /api/clients/[id]/locations/[locationId] — remove the location.
 *
 * Both routes are agency-gated.
 *
 * Promotion rule: setting `is_primary: true` here atomically demotes the
 * existing primary first (the partial unique index would otherwise reject).
 *
 * Delete safety: refuses to delete a primary location if the client has
 * any non-primary siblings — the operator must promote one of those to
 * primary first, otherwise the client would end up with no primary.
 * If the location is the ONLY one, deletion is allowed (the client is
 * effectively becoming locationless, which should be rare and explicit).
 *
 * Cascade behavior on delete: scans/keywords/audits/competitors with
 * matching location_id get their FK set to NULL (per the migration's
 * `on delete set null`). Those rows aren't destroyed but their location
 * pointer is severed. Operator can then re-link them via SQL if needed.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { ClientLocationRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PatchBody = z
  .object({
    label: z.string().min(1).max(80).nullable(),
    address: z.string().min(4).max(400),
    street_address: z.string().min(1).max(200).nullable(),
    city: z.string().min(1).max(120).nullable(),
    region: z.string().min(1).max(120).nullable(),
    postcode: z.string().min(1).max(20).nullable(),
    country_code: z
      .string()
      .length(3, 'ISO-3166-1 alpha-3 (e.g. USA)')
      .nullable(),
    phone: z.string().min(4).max(40).nullable(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    pin_lat: z.number().min(-90).max(90).nullable(),
    pin_lng: z.number().min(-180).max(180).nullable(),
    service_radius_miles: z.number().min(0.1).max(10),
    gbp_url: z.string().url().max(2048).nullable(),
    is_primary: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; locationId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientId, locationId } = await params;

  let parsed: z.infer<typeof PatchBody>;
  try {
    parsed = PatchBody.parse(await req.json());
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

  // Promotion: if caller sets is_primary=true, demote the current primary
  // first so the partial unique index doesn't reject the update.
  if (parsed.is_primary === true) {
    await supabase
      .from('client_locations')
      .update({ is_primary: false })
      .eq('client_id', clientId)
      .eq('is_primary', true)
      .neq('id', locationId);
  }

  const { data: updated, error } = await supabase
    .from('client_locations')
    .update(parsed)
    .eq('id', locationId)
    .eq('client_id', clientId)
    .select('*')
    .maybeSingle<ClientLocationRow>();

  if (error) {
    return NextResponse.json(
      { error: `update failed: ${error.message}` },
      { status: 500 }
    );
  }
  if (!updated) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 });
  }
  return NextResponse.json({ location: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; locationId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientId, locationId } = await params;

  const supabase = getServerSupabase();

  const { data: target } = await supabase
    .from('client_locations')
    .select('id, is_primary')
    .eq('id', locationId)
    .eq('client_id', clientId)
    .maybeSingle<Pick<ClientLocationRow, 'id' | 'is_primary'>>();
  if (!target) {
    return NextResponse.json(
      { error: 'location not found' },
      { status: 404 }
    );
  }

  // Don't orphan a multi-location client — primary deletes only allowed
  // when there's nothing else, OR when the operator has already
  // promoted another sibling to primary.
  if (target.is_primary) {
    const { count: siblingCount } = await supabase
      .from('client_locations')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .neq('id', locationId);
    if ((siblingCount ?? 0) > 0) {
      return NextResponse.json(
        {
          error:
            "can't delete the primary location while siblings exist — promote a different location to primary first",
        },
        { status: 400 }
      );
    }
  }

  const { error: delErr } = await supabase
    .from('client_locations')
    .delete()
    .eq('id', locationId)
    .eq('client_id', clientId);
  if (delErr) {
    return NextResponse.json(
      { error: `delete failed: ${delErr.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, deleted: { id: locationId } });
}
