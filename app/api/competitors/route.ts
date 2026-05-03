/**
 * POST /api/competitors — add a tracked competitor brand for a location.
 * GET  /api/competitors?clientId=...&locationId=... — list (rarely needed; the
 *      settings page server-renders the list directly).
 *
 * Both routes are agency-gated. Competitors are scoped per-location:
 * each storefront has its own optional curated brand list. Empty list
 * = automatic discovery from scan data (the dashboard handles the
 * branching).
 *
 * Body for POST:
 *   { client_id: uuid, location_id: uuid, competitor_name: string }
 *
 * Idempotent insert: a duplicate (client_id, location_id, competitor_name)
 * triple raises a 23505 unique violation which we surface as 409.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

const PostBody = z.object({
  client_id: z.string().uuid(),
  location_id: z.string().uuid(),
  competitor_name: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  let parsed: z.infer<typeof PostBody>;
  try {
    parsed = PostBody.parse(await req.json());
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
  const name = parsed.competitor_name.trim();

  const { data, error } = await supabase
    .from('competitors')
    .insert({
      client_id: parsed.client_id,
      location_id: parsed.location_id,
      competitor_name: name,
    })
    .select('id, client_id, location_id, competitor_name, created_at')
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json(
        { error: `"${name}" is already tracked for this location` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `competitor insert failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ competitor: data });
}
