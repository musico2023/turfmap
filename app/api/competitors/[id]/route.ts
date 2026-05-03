/**
 * DELETE /api/competitors/[id] — remove a tracked competitor by row id.
 *
 * Agency-gated. The row id is the competitors.id UUID that came back in
 * the POST response (or surfaced by the settings page server query).
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const supabase = getServerSupabase();
  const { error } = await supabase.from('competitors').delete().eq('id', id);
  if (error) {
    return NextResponse.json(
      { error: `delete failed: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, deleted: { id } });
}
