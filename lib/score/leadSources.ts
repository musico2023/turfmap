/**
 * Shared lead_source slugs for the /score lead-magnet funnel +
 * the cold-Meta variant landers.
 *
 * The set of slugs that earn the discounted unlock ($99 → $49) on
 * the /share page lives here as the single source of truth so
 * unlock-init (server) and the /share page (server) never drift
 * out of sync.
 *
 * Pattern-matched against an explicit Set rather than "anything
 * non-default" so an unrecognized value fails closed at $99.
 *
 * Adding a new lander? Pick a stable slug, add it here + map it
 * to the right Stripe promotion code in unlockCouponCodeForLeadSource
 * below, then pass it to <ScanIntakeForm leadSource="..." />.
 * Both unlock-init and /share will pick up the discount automatically.
 */

/** Lander identifiers that get a discounted $49 unlock on /share.
 *    - 'free_score' — cold-Meta loss/competitor-stealing variant
 *                     (MAPCHECK50 promo code)
 *    - 'prove_it'   — cold-Meta ego-challenge "PROVE IT" variant
 *                     (MAPCHECK50 promo code)
 *    - 'fourdots'   — fourdots.io exit-intent + downsell variant
 *                     (FOURDOTS50 promo code — same $50 discount,
 *                     separate Stripe code so the channel
 *                     attribution stays clean in reporting)
 *  Homepage /score traffic uses 'score' and stays at $99. */
export const DISCOUNTED_LEAD_SOURCES: ReadonlySet<string> = new Set([
  'free_score',
  'prove_it',
  'fourdots',
]);

/** Returns true when the supplied lead_source qualifies for the
 *  discounted unlock price. Null + unknown slugs both return false
 *  (fail-closed to list price). */
export function isDiscountedLeadSource(
  leadSource: string | null | undefined
): boolean {
  if (!leadSource) return false;
  return DISCOUNTED_LEAD_SOURCES.has(leadSource);
}

/** Maps a discounted lead_source to the specific Stripe promotion
 *  code unlock-init should auto-apply on the /share unlock
 *  Checkout session.
 *
 *  Why separate codes when the discount math is identical:
 *    Cold-Meta and fourdots-exit-intent are different channels with
 *    different reporting needs. Keeping MAPCHECK50 vs. FOURDOTS50
 *    distinct in Stripe + downstream metadata lets the unit-economics
 *    rollup attribute every $49 unlock to the channel that
 *    earned it without having to back-derive from lead_source.
 *
 *  Returns null for undiscounted lead_sources (homepage /score,
 *  legacy/unknown) so callers can branch cleanly without checking
 *  the discounted-set membership separately. */
export function unlockCouponCodeForLeadSource(
  leadSource: string | null | undefined
): string | null {
  if (!leadSource) return null;
  if (leadSource === 'fourdots') return 'FOURDOTS50';
  if (leadSource === 'free_score' || leadSource === 'prove_it') {
    return 'MAPCHECK50';
  }
  return null;
}
