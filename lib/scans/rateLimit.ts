/**
 * On-demand scan rate-limiting per location.
 *
 * The Re-scan turf button calls a real DataForSEO Live Mode scan
 * (~$0.16 per click). Without a guardrail an operator can run 6+ scans
 * in a single day testing GBP edits, burning ~$1 in BL credits and
 * cluttering the score history with noise. We've already filtered the
 * noise out of momentum (12h baseline rule), but the cost is real.
 *
 * Rule: at most 3 ON-DEMAND scans per location per rolling 24 hours.
 * Cron-driven scheduled scans don't count toward the cap — they run
 * once a week on schedule, and a rate-limit on them would defeat the
 * point. Only scan_type='on_demand' gets counted.
 *
 * Enforced server-side at /api/scans/trigger (returns 429 + the next
 * available timestamp) AND surfaced client-side on ScanButton so the
 * operator sees the cap before clicking.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export const ON_DEMAND_SCANS_PER_24H = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type RescanCapStatus = {
  count: number;
  limit: number;
  /** True iff `count >= limit` — i.e., the next on-demand scan is blocked. */
  atCap: boolean;
  /** ISO timestamp when the oldest scan in the window will fall out of
   *  the 24h frame, freeing a slot. Null when count === 0. */
  nextAvailableAt: string | null;
};

/**
 * Count on-demand scans for a location inside the last 24h and return
 * the cap status. The oldest scan in the window dictates when the next
 * slot frees up.
 */
export async function getRescanCapStatus(
  supabase: SupabaseLike,
  locationId: string
): Promise<RescanCapStatus> {
  const cutoffIso = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: rows } = await supabase
    .from('scans')
    .select('created_at')
    .eq('location_id', locationId)
    .eq('scan_type', 'on_demand')
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .returns<Array<{ created_at: string | null }>>();
  const window = rows ?? [];
  const count = window.length;
  const oldest = window[0]?.created_at;
  const nextAvailableAt = oldest
    ? new Date(new Date(oldest).getTime() + WINDOW_MS).toISOString()
    : null;
  return {
    count,
    limit: ON_DEMAND_SCANS_PER_24H,
    atCap: count >= ON_DEMAND_SCANS_PER_24H,
    nextAvailableAt,
  };
}
