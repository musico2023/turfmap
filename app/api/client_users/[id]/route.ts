/**
 * DELETE /api/client_users/[id] — revoke a portal user's access.
 *
 * Only deletes the membership row. The Supabase auth.users row (created on
 * first magic-link sign-in) stays alive — Anthony or another agency can
 * re-add the email under a different client without a separate user-purge
 * step.
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
    .from('client_users')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) {
    return NextResponse.json(
      { error: `delete failed: ${error.message}` },
      { status: 500 }
    );
  }
  if (!count) {
    return NextResponse.json(
      { error: 'portal user not found' },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
