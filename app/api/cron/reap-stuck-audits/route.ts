/**
 * Vercel Cron — stuck NAP-audit reaper.
 *
 * Schedule (vercel.json): hourly at :20, offset from poll-citations at
 * :00 so the two citation crons don't contend for the same DFS/BL
 * budget window.
 *
 * The DFS checker is synchronous and self-reporting, so it handles its
 * own errors — what it cannot handle is the process dying mid-run, which
 * strands the row at `pending` forever and leaves the buyer's AI Coach
 * and Roadmap PDF with an empty NAP section. This sweep is that missing
 * recovery path. See lib/citations/reapStuckAudits.ts for the full
 * rationale, thresholds, and runaway protection.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — same pattern as
 * weekly-scans and poll-citations. Vercel Cron sets the header
 * automatically when CRON_SECRET is configured.
 *
 * Returns: ReapSweepResult — { scanned, left, reaped, retried, healed,
 * escalated, errors }.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { reapStuckNapAudits } from '@/lib/citations/reapStuckAudits';

export const runtime = 'nodejs';
// Each retry is one synchronous DFS audit (~5-9s) and the per-tick retry
// budget is 10, so the worst realistic case is ~90s of audits plus the
// sweep queries. 300s leaves comfortable headroom for a slow DFS day.
export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 503 }
    );
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const result = await reapStuckNapAudits(supabase);

  if (result.reaped > 0 || result.errors.length > 0) {
    console.log(
      `[cron/reap-stuck-audits] scanned=${result.scanned} reaped=${result.reaped} retried=${result.retried} healed=${result.healed} escalated=${result.escalated} errors=${result.errors.length}`
    );
    for (const e of result.errors) {
      console.error(`[cron/reap-stuck-audits] ${e}`);
    }
  }

  return NextResponse.json(result);
}
