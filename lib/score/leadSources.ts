/**
 * Shared lead_source slugs for the /score lead-magnet funnel +
 * the cold-Meta variant landers.
 *
 * The set of slugs that earn the discounted MAPCHECK50 unlock
 * ($99 → $49) on the /share page lives here as the single source
 * of truth so unlock-init (server) and the /share page (server)
 * never drift out of sync.
 *
 * Pattern-matched against an explicit Set rather than "anything
 * non-default" so an unrecognized value fails closed at $99.
 *
 * Adding a new Meta lander? Pick a stable slug, add it here, pass
 * it to <ScanIntakeForm leadSource="..." />. Both unlock-init and
 * /share will pick up the discount automatically.
 */

/** Lander identifiers that get the MAPCHECK50 ($49) unlock on
 *  /share. Currently both Meta-cold-traffic landers:
 *    - 'free_score' — the loss/competitor-stealing variant
 *    - 'prove_it'   — the ego-challenge "PROVE IT" variant
 *  Homepage /score traffic uses 'score' and stays at $99. */
export const DISCOUNTED_LEAD_SOURCES: ReadonlySet<string> = new Set([
  'free_score',
  'prove_it',
]);

/** Returns true when the supplied lead_source qualifies for the
 *  discounted Meta-cohort unlock price. Null + unknown slugs both
 *  return false (fail-closed to list price). */
export function isDiscountedLeadSource(
  leadSource: string | null | undefined
): boolean {
  if (!leadSource) return false;
  return DISCOUNTED_LEAD_SOURCES.has(leadSource);
}
