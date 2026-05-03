/**
 * POST /api/keywords — add a tracked keyword to an existing client.
 *
 * Body: { client_id, keyword, scan_frequency?, is_primary? }
 *
 * Validation:
 *   - The (client_id, keyword) unique constraint at the DB level catches
 *     duplicates and surfaces a friendly error.
 *   - If is_primary=true, we first un-primary any existing primary on that
 *     client so there's only ever one.
 *
 * Returns the created keyword row.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { resolveLocation } from '@/lib/supabase/locations';
import type { TrackedKeywordRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PostBody = z.object({
  client_id: z.string().uuid(),
  /** Optional. Defaults to the client's primary location. Multi-location
   *  clients pass the active location id so the keyword belongs to that
   *  storefront's scan set. */
  location_id: z.string().uuid().optional(),
  keyword: z.string().min(2).max(160),
  scan_frequency: z
    .enum(['daily', 'weekly', 'biweekly', 'monthly'])
    .optional(),
  is_primary: z.boolean().optional(),
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

  // Resolve the location this keyword should belong to. Defaults to the
  // client's primary location for single-location callers and old code
  // paths that don't pass location_id.
  const location = await resolveLocation(
    supabase,
    parsed.client_id,
    parsed.location_id ?? null
  );
  if (!location) {
    return NextResponse.json(
      {
        error:
          'no location resolved for this client — add at least one location before adding keywords',
      },
      { status: 400 }
    );
  }

  // Ensure single-primary invariant — scoped to the LOCATION since each
  // location has its own primary keyword.
  if (parsed.is_primary) {
    await supabase
      .from('tracked_keywords')
      .update({ is_primary: false })
      .eq('client_id', parsed.client_id)
      .eq('location_id', location.id)
      .eq('is_primary', true);
  }

  const { data: kw, error } = await supabase
    .from('tracked_keywords')
    .insert({
      client_id: parsed.client_id,
      location_id: location.id,
      keyword: parsed.keyword.trim(),
      scan_frequency: parsed.scan_frequency ?? 'weekly',
      is_primary: parsed.is_primary ?? false,
    })
    .select('*')
    .single<TrackedKeywordRow>();

  if (error) {
    // 23505 = unique_violation in Postgres
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json(
        { error: 'this keyword is already tracked for this client' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `keyword insert failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(kw);
}
