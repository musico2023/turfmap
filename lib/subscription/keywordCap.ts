/**
 * Tier-driven keyword-cap helpers — server-side enforcement at scan
 * time. Two surfaces share this logic:
 *
 *   - app/api/cron/weekly-scans   → skip the scan with `over_cap`
 *   - app/api/scans/trigger        → 403 with kind:'over_cap'
 *
 * Why this lives separately from the keyword-add cap in
 * /api/keywords (which uses count-based rejection): on downgrade,
 * existing keywords stay tracked. We can't retroactively delete
 * them — that would silently destroy operator data — but we DO
 * need to stop scheduled + on-demand scans from firing for the
 * over-cap rows. The "in-cap" set is the first `cap` keywords by
 * (is_primary DESC, created_at ASC) — same ordering the dashboard
 * uses to render keywords. That gives a stable, deterministic
 * cutoff: primary keyword first, then earliest-added wins.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClientRow,
  SubscriptionTier,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { maxKeywordsPerLocation, resolveTier } from './tier';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type CapCheck = {
  inCap: boolean;
  cap: number;
  tier: SubscriptionTier | null;
  /** Position of this keyword in the (is_primary DESC, created_at ASC)
   *  ordering for its location. 1-indexed; lets the caller surface
   *  "keyword #4 of 3-keyword plan" if useful. */
  position: number;
};

/**
 * Determine whether a single keyword on a given location is inside
 * the tier's cap. Returns the ordered position so callers can render
 * "over by N" copy.
 *
 * Returns inCap=true defensively when the keyword can't be found in
 * its own location's keyword list — indicates upstream data drift,
 * and we'd rather scan than silently drop.
 */
export async function isKeywordWithinCap(
  supabase: SupabaseLike,
  args: { clientId: string; locationId: string; keywordId: string }
): Promise<CapCheck> {
  const { data: clientRow } = await supabase
    .from('clients')
    .select('tier, billing_mode')
    .eq('id', args.clientId)
    .maybeSingle<Pick<ClientRow, 'tier' | 'billing_mode'>>();
  const tier = clientRow ? resolveTier(clientRow) : null;
  const cap = maxKeywordsPerLocation(tier);

  const { data: keywordsAtLocation } = await supabase
    .from('tracked_keywords')
    .select('id, is_primary, created_at')
    .eq('client_id', args.clientId)
    .eq('location_id', args.locationId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .returns<
      Pick<TrackedKeywordRow, 'id' | 'is_primary' | 'created_at'>[]
    >();

  const list = keywordsAtLocation ?? [];
  const idx = list.findIndex((k) => k.id === args.keywordId);
  if (idx < 0) {
    // Defensive: keyword not in this location's set. Don't block —
    // the cron's other guards (location coords, idempotency) will
    // surface the real issue.
    return { inCap: true, cap, tier, position: 0 };
  }
  return { inCap: idx < cap, cap, tier, position: idx + 1 };
}

/**
 * Pre-compute the in-cap keyword id set for a location given a
 * tier-resolved cap and a pre-fetched keyword list. Cron uses this
 * to avoid an N+1 round-trip per (location, keyword) pair — it
 * already loads all keywords up front.
 *
 * The list MUST be ordered by (is_primary DESC, created_at ASC) for
 * the cutoff to match the dashboard + the single-keyword check above.
 */
export function inCapKeywordIds(
  orderedKeywords: Pick<TrackedKeywordRow, 'id'>[],
  cap: number
): Set<string> {
  return new Set(orderedKeywords.slice(0, cap).map((k) => k.id));
}
