/**
 * NAP-edit re-sync gate (item 6 in the launch roadmap).
 *
 * Pulse+ subscribers get free re-syncs to BrightLocal up to a quota
 * cap. Over-cap re-syncs charge passthrough markup via a Stripe
 * one-off invoice. Without this gate, a buyer who edits their
 * address weekly during onboarding could burn $1,500+ in BL sync
 * credits — Pulse+ would lose money on that account.
 *
 * Quota policy (decided in the roadmap conversation, 2026-05-04):
 *   - Onboarding window (first 30 days post-Pulse+ signup): 3 free
 *     full re-syncs absorbed.
 *   - Steady state: 3 free re-syncs per location per quarter.
 *   - Above the cap: $8/directory passthrough (BL wholesale ~$5,
 *     ~$3 margin per dir). Billed via Stripe one-off invoice on the
 *     next billing cycle.
 *
 * Field-aware gating:
 *   - HIGH-CHURN fields (address, phone, business name) trigger
 *     a sync + count against the quota.
 *   - LOW-CHURN fields (hours, photos, description, GBP categories)
 *     sync free at BL — no quota cost.
 *
 * The high-churn list maps to the BL fields most expensive to
 * propagate (each requires per-directory verification at the
 * destination); low-churn fields are aggregator-pushed and don't
 * trigger directory-by-directory verification fees.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CitationOrderRow,
  CitationSubmittedProfile,
  ClientLocationRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

/** Free re-syncs per quarter (steady state). Mirrored on the
 *  onboarding window — first 30 days post-Pulse+ signup also gets 3,
 *  per the 2026-05-04 decision. */
export const RESYNC_FREE_QUOTA = 3;

/** Per-directory passthrough cost in cents when over the cap.
 *  $8/dir = 800 cents. */
export const OVER_CAP_PRICE_CENTS_PER_DIRECTORY = 800;

/** Fields that trigger a BL re-sync when changed. Anything outside
 *  this set is either a no-op (handled by free aggregator push) or
 *  isn't a NAP field at all. */
const HIGH_CHURN_KEYS = [
  'business_name',
  'street_address',
  'city',
  'region',
  'postcode',
  'country_code',
  'phone',
] as const;
type HighChurnKey = (typeof HIGH_CHURN_KEYS)[number];

export type ResyncQuotaStatus = {
  /** How many free re-syncs the location has used in the current
   *  window. Counter resets to 0 on the quarterly reset cron. */
  used: number;
  /** Same as RESYNC_FREE_QUOTA — surfaced for UI symmetry. */
  cap: number;
  /** Convenience: cap - used, never negative. */
  remaining: number;
  /** True iff used >= cap — next re-sync is over-cap. */
  atCap: boolean;
  /** ISO timestamp of the next quarterly counter reset. Null if the
   *  location hasn't burned a re-sync yet (counter never started). */
  resetsAt: string | null;
};

/**
 * Read the current re-sync quota for a location. Lightweight — one
 * query against client_locations. Caller owns "is this even a
 * Pulse+ client" gating; this just reads the counter.
 */
export async function getResyncQuotaStatus(
  supabase: SupabaseLike,
  locationId: string
): Promise<ResyncQuotaStatus> {
  const { data: loc } = await supabase
    .from('client_locations')
    .select('citation_resync_count, citation_resync_quota_resets_at')
    .eq('id', locationId)
    .maybeSingle<
      Pick<
        ClientLocationRow,
        'citation_resync_count' | 'citation_resync_quota_resets_at'
      >
    >();

  const used = loc?.citation_resync_count ?? 0;
  return {
    used,
    cap: RESYNC_FREE_QUOTA,
    remaining: Math.max(0, RESYNC_FREE_QUOTA - used),
    atCap: used >= RESYNC_FREE_QUOTA,
    resetsAt: loc?.citation_resync_quota_resets_at ?? null,
  };
}

/**
 * Compare a new profile against the order's submitted_profile and
 * return the set of high-churn fields that actually changed. Empty
 * array = no sync needed (low-churn-only edit).
 */
export function diffHighChurnFields(
  oldProfile: Pick<CitationSubmittedProfile, HighChurnKey> | null,
  newProfile: Pick<CitationSubmittedProfile, HighChurnKey>
): HighChurnKey[] {
  if (!oldProfile) return [...HIGH_CHURN_KEYS];
  const changed: HighChurnKey[] = [];
  for (const key of HIGH_CHURN_KEYS) {
    if ((oldProfile[key] ?? null) !== (newProfile[key] ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}

export type ResyncCostEstimate = {
  /** True if the re-sync is covered by the free quota. */
  free: boolean;
  /** Quota state at the moment this estimate was computed. */
  quota: ResyncQuotaStatus;
  /** High-churn fields that would actually trigger a sync. Empty
   *  array means "no sync needed" — no cost, no quota burn. */
  changedFields: HighChurnKey[];
  /** Number of directories that would receive the update — drives
   *  the over-cap cost calculation. Equals
   *  citation_orders.per_directory.length when an open order exists.
   *  0 when no order exists (operator should run the initial build
   *  before re-syncing). */
  directoryCount: number;
  /** Cost to charge the buyer in cents. Zero when free=true. */
  costCents: number;
  /** Per-directory unit price for over-cap ($8/dir as of 2026-05-04). */
  perDirectoryCents: number;
};

/**
 * Compute what a re-sync would cost given the current quota + the
 * proposed profile change. The UI uses this to drive the
 * confirmation modal — buyer sees the cost (or "free, X of N
 * remaining this quarter") before confirming the save.
 */
export async function estimateResyncCost(
  supabase: SupabaseLike,
  locationId: string,
  proposedProfile: Pick<CitationSubmittedProfile, HighChurnKey>
): Promise<ResyncCostEstimate> {
  // Fetch the open citation order's submitted profile + directory
  // count. No open order means no sync to fire — the cost is zero
  // and the change is harmless.
  const { data: order } = await supabase
    .from('citation_orders')
    .select('submitted_profile, per_directory')
    .eq('location_id', locationId)
    .eq('maintenance_paused', false)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<CitationOrderRow, 'submitted_profile' | 'per_directory'>>();

  const changedFields = diffHighChurnFields(
    order?.submitted_profile
      ? extractHighChurn(order.submitted_profile)
      : null,
    proposedProfile
  );
  const directoryCount = order?.per_directory?.length ?? 0;

  if (changedFields.length === 0 || directoryCount === 0) {
    // No high-churn change OR no directories to update — free, no
    // quota burn.
    const quota = await getResyncQuotaStatus(supabase, locationId);
    return {
      free: true,
      quota,
      changedFields: [],
      directoryCount,
      costCents: 0,
      perDirectoryCents: OVER_CAP_PRICE_CENTS_PER_DIRECTORY,
    };
  }

  const quota = await getResyncQuotaStatus(supabase, locationId);
  if (!quota.atCap) {
    return {
      free: true,
      quota,
      changedFields,
      directoryCount,
      costCents: 0,
      perDirectoryCents: OVER_CAP_PRICE_CENTS_PER_DIRECTORY,
    };
  }
  return {
    free: false,
    quota,
    changedFields,
    directoryCount,
    costCents: directoryCount * OVER_CAP_PRICE_CENTS_PER_DIRECTORY,
    perDirectoryCents: OVER_CAP_PRICE_CENTS_PER_DIRECTORY,
  };
}

/**
 * Decrement the free-quota counter for a location. Sets resets_at
 * lazily on first use (counter starts ticking from the first
 * re-sync). Called after a free re-sync confirms successfully.
 */
export async function consumeFreeResync(
  supabase: SupabaseLike,
  locationId: string
): Promise<void> {
  const { data: loc } = await supabase
    .from('client_locations')
    .select('citation_resync_count, citation_resync_quota_resets_at')
    .eq('id', locationId)
    .maybeSingle<
      Pick<
        ClientLocationRow,
        'citation_resync_count' | 'citation_resync_quota_resets_at'
      >
    >();

  const newCount = (loc?.citation_resync_count ?? 0) + 1;
  const resetsAt = loc?.citation_resync_quota_resets_at ?? nextQuarterResetIso();

  await supabase
    .from('client_locations')
    .update({
      citation_resync_count: newCount,
      citation_resync_quota_resets_at: resetsAt,
    })
    .eq('id', locationId);
}

/**
 * Reset every location's quota back to 0. Called by the
 * /api/cron/reset-citation-quotas cron at the start of each quarter.
 */
export async function resetAllResyncQuotas(
  supabase: SupabaseLike
): Promise<{ reset: number }> {
  const nextReset = nextQuarterResetIso();
  const { count } = await supabase
    .from('client_locations')
    .update(
      {
        citation_resync_count: 0,
        citation_resync_quota_resets_at: nextReset,
      },
      { count: 'exact' }
    )
    .gt('citation_resync_count', 0);
  return { reset: count ?? 0 };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractHighChurn(
  profile: CitationSubmittedProfile
): Pick<CitationSubmittedProfile, HighChurnKey> {
  return {
    business_name: profile.business_name,
    street_address: profile.street_address,
    city: profile.city,
    region: profile.region,
    postcode: profile.postcode,
    country_code: profile.country_code,
    phone: profile.phone,
  };
}

/** ISO timestamp of the start of the next calendar quarter (UTC). */
function nextQuarterResetIso(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0–11
  const nextQuarterStartMonth = Math.floor(month / 3) * 3 + 3; // 3, 6, 9, 12
  const reset = new Date(
    Date.UTC(
      nextQuarterStartMonth >= 12 ? year + 1 : year,
      nextQuarterStartMonth >= 12 ? 0 : nextQuarterStartMonth,
      1,
      0,
      0,
      0
    )
  );
  return reset.toISOString();
}
