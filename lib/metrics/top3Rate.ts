/**
 * 3-Pack Win Rate — percentage of grid points where the business shows up
 * in the local 3-pack (rank 1, 2, or 3).
 *
 * Returns an integer 0-100. Null ranks (not in pack) and ranks > 3 both
 * count as misses.
 */

export function top3Rate(ranks: Array<number | null>): number {
  if (!ranks.length) return 0;
  const hits = ranks.filter((r) => r !== null && r <= 3).length;
  return Math.round((hits / ranks.length) * 100);
}
