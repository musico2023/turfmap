/**
 * Operator UI for the Google Places match-confirmation step.
 *
 * GET   — returns the current match state + the latest signals row
 *         (so the locations panel can render rating/category/etc.)
 * POST  — action discriminator:
 *           { action: 'confirm' }                — mark current match as 'confirmed'
 *           { action: 'reject' }                  — clear place_id, status='rejected'
 *           { action: 'search', query: string }   — multi-result search; returns candidates
 *           { action: 'select', placeId: string } — pick a candidate manually; status='manual'
 *
 * All operations are agency-gated. Match-state changes are no-ops
 * when GOOGLE_PLACES_API_KEY isn't configured (the underlying
 * helpers soft-fail).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { resolveClientUuid } from '@/lib/supabase/client-lookup';
import {
  confirmMatch,
  rejectMatch,
  selectMatchManually,
  getLatestSignals,
  type GbpSignalsRow,
} from '@/lib/google/enrich';
import { searchPlaces } from '@/lib/google/places';
import type { ClientLocationRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PostBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('reject') }),
  z.object({ action: z.literal('search'), query: z.string().min(1).max(200) }),
  z.object({ action: z.literal('select'), placeId: z.string().min(1).max(300) }),
]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; locationId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam, locationId } = await params;
  const supabase = getServerSupabase();
  const clientId = await resolveClientUuid(supabase, clientParam);
  if (!clientId) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const { data: location } = await supabase
    .from('client_locations')
    .select(
      'id, google_place_id, google_place_match_status, google_place_match_distance_m, google_place_match_name_similarity'
    )
    .eq('id', locationId)
    .eq('client_id', clientId)
    .maybeSingle<
      Pick<
        ClientLocationRow,
        | 'id'
        | 'google_place_id'
        | 'google_place_match_status'
        | 'google_place_match_distance_m'
        | 'google_place_match_name_similarity'
      >
    >();
  if (!location) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 });
  }

  const signals: GbpSignalsRow | null = await getLatestSignals(
    supabase,
    locationId
  );

  return NextResponse.json({
    placeId: location.google_place_id,
    status: location.google_place_match_status,
    matchDistanceM: location.google_place_match_distance_m,
    matchNameSimilarity: location.google_place_match_name_similarity,
    signals,
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; locationId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam, locationId } = await params;

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
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
  const clientId = await resolveClientUuid(supabase, clientParam);
  if (!clientId) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Verify the location belongs to the client before mutating.
  const { data: ownership } = await supabase
    .from('client_locations')
    .select('id, latitude, longitude')
    .eq('id', locationId)
    .eq('client_id', clientId)
    .maybeSingle<Pick<ClientLocationRow, 'id' | 'latitude' | 'longitude'>>();
  if (!ownership) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 });
  }

  switch (body.action) {
    case 'confirm': {
      const ok = await confirmMatch(supabase, locationId);
      if (!ok) {
        return NextResponse.json({ error: 'update failed' }, { status: 500 });
      }
      return NextResponse.json({ ok: true, status: 'confirmed' });
    }
    case 'reject': {
      const ok = await rejectMatch(supabase, locationId);
      if (!ok) {
        return NextResponse.json({ error: 'update failed' }, { status: 500 });
      }
      return NextResponse.json({ ok: true, status: 'rejected' });
    }
    case 'search': {
      if (!process.env.GOOGLE_PLACES_API_KEY) {
        return NextResponse.json(
          { error: 'GOOGLE_PLACES_API_KEY is not configured' },
          { status: 503 }
        );
      }
      const result = await searchPlaces({
        query: body.query,
        latitude: ownership.latitude,
        longitude: ownership.longitude,
      });
      return NextResponse.json({
        candidates: result.candidates,
        cost_cents: result.costCents,
      });
    }
    case 'select': {
      if (!process.env.GOOGLE_PLACES_API_KEY) {
        return NextResponse.json(
          { error: 'GOOGLE_PLACES_API_KEY is not configured' },
          { status: 503 }
        );
      }
      const ok = await selectMatchManually(supabase, {
        locationId,
        placeId: body.placeId,
      });
      if (!ok) {
        return NextResponse.json(
          { error: 'place lookup or update failed' },
          { status: 502 }
        );
      }
      return NextResponse.json({ ok: true, status: 'manual' });
    }
  }
}
