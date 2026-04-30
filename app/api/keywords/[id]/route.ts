/**
 * DELETE /api/keywords/[id] — remove a tracked keyword.
 *
 * Cascades to scans referencing this keyword (ON DELETE CASCADE in the
 * schema). That's intentional — a removed keyword's history goes with it.
 *
 * If you delete the only keyword on a client, the cron job will skip that
 * client until you add a new one. The dashboard handles a missing keyword
 * gracefully (shows "—").
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

  const { error, count } = await supabase
    .from('tracked_keywords')
    .delete({ count: 'exact' })
    .eq('id', id);

  if (error) {
    return NextResponse.json(
      { error: `delete failed: ${error.message}` },
      { status: 500 }
    );
  }
  if (!count) {
    return NextResponse.json({ error: 'keyword not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
