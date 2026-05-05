/**
 * Vercel Cron — reset citation re-sync quotas at the start of each
 * calendar quarter.
 *
 * Schedule (vercel.json): 00:05 UTC on Jan 1, Apr 1, Jul 1, Oct 1.
 *
 * For every client_locations row with citation_resync_count > 0,
 * resets the counter to 0 and stamps citation_resync_quota_resets_at
 * to the next quarterly boundary. Locations that haven't burned a
 * re-sync this quarter are left alone.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — matches the other
 * cron routes' pattern.
 *
 * Returns: { reset }
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { resetAllResyncQuotas } from '@/lib/citations/resync';

export const runtime = 'nodejs';
// Single bulk update — under 5s comfortably even at 10k+ locations.
export const maxDuration = 60;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 503 }
    );
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const { reset } = await resetAllResyncQuotas(supabase);
  return NextResponse.json({ reset });
}
