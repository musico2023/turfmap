/**
 * POST /api/prospect/[id]/engaged
 *
 * Stamps prospects.scan_engaged_at when a warm-cohort prospect
 * first views their TurfMap dashboard after purchasing the free
 * TurfScan via /freescan. This timestamp is the trigger gate for
 * the Stage 2 audit-upgrade email (Fix 3.1 in MARKETING_BRIEF).
 *
 * Idempotent: if scan_engaged_at is already set, no-op. This lets
 * the dashboard fire-and-forget on every page load without races
 * or duplicate Stage 2 sends.
 *
 * Cohort-scoped: only fires for prospects with
 * cohort='crm_reactivation_q2'. Cold-email cohort dashboard views
 * don't have a Stage 2 sequence wired to engagement, so we skip the
 * write to keep the column meaningful for the warm cohort.
 *
 * No rate limit — this is fired by the buyer's own browser on a
 * page they own access to. Rate-limiting it would do nothing
 * useful (worst case: a 10x-engaged prospect updates the timestamp
 * on the first hit; subsequent hits no-op due to idempotency).
 *
 * No auth — the endpoint takes a prospect_id which acts as the
 * capability token. Brute-forcing nanoids over the rate-limited
 * GET endpoint already shows this is not a security boundary.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { error: 'prospect_id_required' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Fetch + filter in a single round-trip: only stamp when
  // (cohort = 'crm_reactivation_q2', scan_engaged_at IS NULL).
  // We use a conditional update via .is('scan_engaged_at', null)
  // so a second hit returns 0 rows and we no-op cleanly.
  const { data, error } = await supabase
    .from('prospects')
    .update({ scan_engaged_at: new Date().toISOString() })
    .eq('id', id)
    .eq('cohort', 'crm_reactivation_q2')
    .is('scan_engaged_at', null)
    .select('id, scan_engaged_at')
    .maybeSingle();

  if (error) {
    // Don't fail the dashboard render on a write error — just
    // surface a 200 with status=error so the client can log it.
    return NextResponse.json(
      { status: 'error', message: error.message },
      { status: 200 }
    );
  }

  // data is null when the conditional matched 0 rows (already set,
  // or not in warm cohort). Both are no-op cases.
  if (!data) {
    return NextResponse.json({ status: 'noop' }, { status: 200 });
  }

  return NextResponse.json({
    status: 'stamped',
    scan_engaged_at: data.scan_engaged_at,
  });
}
