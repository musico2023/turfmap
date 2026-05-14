/**
 * Tier resolver + feature gates.
 *
 * Single source of truth for "what tier is this client on?" and
 * "what does that tier unlock?". Every feature gate across the
 * codebase imports from here so a tier-policy change ripples
 * cleanly through every surface.
 *
 * Resolver order:
 *   1. clients.tier column (writable by operators + Stripe webhook)
 *   2. NULL — meaning the client has no recurring tier (one_time)
 *
 * Future: when the Stripe webhook ships, it'll write tier on
 * customer.subscription.created based on the Price the buyer
 * subscribed to. Until then, operators set it via the override
 * endpoint at /api/clients/[id]/tier.
 */

import type { ClientRow, SubscriptionTier } from '@/lib/supabase/types';

/** What tier does this client effectively have? */
export function resolveTier(
  client: Pick<ClientRow, 'tier' | 'billing_mode'>
): SubscriptionTier | null {
  // one_time clients (TurfScan / Audit / Strategy) never have a
  // recurring tier even if tier was somehow set on the row.
  if (client.billing_mode === 'one_time') return null;
  return client.tier ?? null;
}

// ─── Feature gates ─────────────────────────────────────────────────────────
//
// Each gate is a tiny function so the call site reads as
// `if (canAccessCitations(tier))` rather than `tier === 'pulse_plus'`,
// which keeps the policy decision in one place.
//
// All gates accept `tier | null` and return false on null — clients
// with no recurring tier (one_time / not yet set) get nothing.

export function canAccessCitations(
  tier: SubscriptionTier | null
): boolean {
  return tier === 'pulse_plus';
}

export function canAccessExports(
  tier: SubscriptionTier | null
): boolean {
  return tier === 'pulse_plus';
}

export function canAccessSlackIntegration(
  tier: SubscriptionTier | null
): boolean {
  return tier === 'pulse_plus';
}

/** Pulse gets basic alerts (score movement, weekly competitor
 *  summary). Pulse+ adds the granular set (competitor entries,
 *  momentum reversal, cell-level changes). */
export function canAccessGranularAlerts(
  tier: SubscriptionTier | null
): boolean {
  return tier === 'pulse_plus';
}

export function canAccessTrendChart(
  tier: SubscriptionTier | null
): boolean {
  // Both tiers get the trend chart — Pulse marketing copy doesn't
  // promise it, but the feature is functional and we've already
  // shipped it on the scans page. No reason to gate.
  return tier === 'pulse' || tier === 'pulse_plus';
}

/** Keyword cap per location. Pulse: 3, Pulse+: 10. NULL tier (one_time
 *  / unset) defaults to 1 — they bought a single-keyword scan. */
export function maxKeywordsPerLocation(
  tier: SubscriptionTier | null
): number {
  if (tier === 'pulse_plus') return 10;
  if (tier === 'pulse') return 3;
  return 1;
}

/** Display label for the tier — used in the UI badges + the
 *  agency-side override card. */
export function tierLabel(tier: SubscriptionTier | null): string {
  if (tier === 'pulse_plus') return 'Pulse+';
  if (tier === 'pulse') return 'Pulse';
  return 'No recurring tier';
}
