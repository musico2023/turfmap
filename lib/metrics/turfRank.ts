/**
 * TurfRank — rank quality on a 0-3 scale, computed only across cells
 * where the business actually appears in the local 3-pack.
 *
 * Formula: 4 - avg_rank_when_present
 *   ranks = [1, 1, 1]      → avg 1.0 → TurfRank 3.0  (always #1)
 *   ranks = [1, 2, 3]      → avg 2.0 → TurfRank 2.0  (always #2 on average)
 *   ranks = [3, 3, 3]      → avg 3.0 → TurfRank 1.0  (always #3)
 *   ranks = [null, null]   → no in-pack cells       → null
 *
 * Returns null when the business doesn't appear in any cell — the UI
 * renders that as "—" with an "Establishing baseline" caption rather
 * than 0 (which would falsely imply rank-3 performance).
 *
 * Replaces the prior `packStrength` helper (which used a 0-100 scale
 * of `100 - 5×avg`). The 0-3 scale was chosen for the redesign
 * because it's the most intuitive direct mapping to "what's your
 * average rank in the 3-pack" — viewers immediately understand
 * "2.4 / 3" as "almost #1 across the territory you cover."
 */

export function turfRank(ranks: Array<number | null>): number | null {
  const inPack = ranks.filter((r): r is number => r !== null && r >= 1 && r <= 3);
  if (inPack.length === 0) return null;
  const avg = inPack.reduce((a, b) => a + b, 0) / inPack.length;
  // 4 − avg gives the desired 0..3 scale (clamped just in case some
  // exotic rank value sneaks through — it shouldn't on local-pack data).
  return Math.max(0, Math.min(3, Math.round((4 - avg) * 10) / 10));
}

/** Categorical caption for a TurfRank value (used by dashboard + portal). */
export function turfRankCaption(rank: number | null): string {
  if (rank === null || rank === undefined) return 'Establishing baseline';
  if (rank >= 2.5) return 'Strong position when you appear';
  if (rank >= 2.0) return 'Solid position when you appear';
  if (rank >= 1.5) return 'Mid-pack — room to climb';
  return 'Edge of pack — focus on rank quality';
}
