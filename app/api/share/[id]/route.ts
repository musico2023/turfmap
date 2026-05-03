/**
 * DELETE /api/share/[id] — revoke a share link before its expiry.
 *
 * Agency-gated. Sets revoked_at to NOW() rather than deleting the row,
 * so audit trail (view counts, who created it, when) is preserved.
 *
 * The corresponding POST/GET routes that create + list share links
 * live under /api/scans/[id]/share — they're keyed by scan-id, while
 * this route is keyed by share-link-id (which is what the agency
 * actually has on the dashboard when they click "Revoke").
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
  const { data, error } = await supabase
    .from('scan_share_links')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) {
    return NextResponse.json(
      { error: `revoke failed: ${error.message}` },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: 'share link not found or already revoked' },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, revokedId: data.id });
}
