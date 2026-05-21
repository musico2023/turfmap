/**
 * POST /api/prospect/[id]/engaged
 *
 * Stamps prospects.scan_engaged_at when an outreach-cohort prospect
 * first sees their fulfilled scan after purchasing the TurfScan via
 * /freescan (warm) or /yourmap (cold). This timestamp is the trigger
 * gate for the post-purchase email sequences:
 *   - warm cohort  → Stage 2 audit-upgrade  (crmvip-stage2 cron)
 *   - cold cohort  → Stage 3 audit offer    (cold-stage3 cron)
 *   - both cohorts → AI Coach nudge         (ai-coach-nudge cron)
 *
 * Idempotent: if scan_engaged_at is already set, no-op. This lets
 * the dashboard fire-and-forget on every page load without races
 * or duplicate sends.
 *
 * Cohort-scoped: only stamps for the two outreach cohorts listed in
 * ENGAGEMENT_COHORTS. Organically-acquired prospects (or any other
 * cohort) have no engagement-gated sequence, so we skip the write to
 * keep the column meaningful. Previously this was warm-only, which
 * silently starved the entire cold funnel — cold-stage3 + cold-side
 * ai-coach-nudge can only fire once scan_engaged_at is set.
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

/**
 * Cohorts whose post-purchase email sequence is gated on
 * scan_engaged_at. Keep in sync with the cohort filters in the
 * crmvip-stage2 (warm) and cold-stage3 (cold) crons.
 */
const ENGAGEMENT_COHORTS = ['crm_reactivation_q2', 'cold_email_q2_2026'];

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
  // (cohort IN ENGAGEMENT_COHORTS, scan_engaged_at IS NULL).
  // We use a conditional update via .is('scan_engaged_at', null)
  // so a second hit returns 0 rows and we no-op cleanly.
  const { data, error } = await supabase
    .from('prospects')
    .update({ scan_engaged_at: new Date().toISOString() })
    .eq('id', id)
    .in('cohort', ENGAGEMENT_COHORTS)
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
  // or not in an engagement-gated cohort). Both are no-op cases.
  if (!data) {
    return NextResponse.json({ status: 'noop' }, { status: 200 });
  }

  return NextResponse.json({
    status: 'stamped',
    scan_engaged_at: data.scan_engaged_at,
  });
}
