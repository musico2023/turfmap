/**
 * TurfScore — composite headline metric, 0-100.
 *
 * Formula: TurfReach × (TurfRank / 3)
 *   - TurfReach: 0..100 (coverage)
 *   - TurfRank: 0..3 (rank quality where present); null treated as 0
 *
 * Examples:
 *   reach 100, rank 3.0 → 100 × 1.0 = 100   (#1 in every cell)
 *   reach 100, rank 2.0 → 100 × 0.67 ≈ 67   (always #2 across full territory)
 *   reach 17,  rank 2.6 → 17  × 0.87 ≈ 15   (Kidcrew today)
 *   reach 100, rank 2.19 → 100 × 0.73 ≈ 73  (Logik today)
 *   reach 0,   rank null →                  0
 *
 * Replaces the prior AMR-based formula (`100 - 5 × AMR with null=20
 * penalty`). The composite shape is preferred because it cleanly
 * separates the two underlying drivers (reach and rank) into named,
 * inspectable sub-metrics that each tell a story on their own.
 *
 * Returns an integer 0..100. Internally clamped because floating-
 * point math on `× 100/3` can overshoot by an epsilon in edge cases.
 */

export function composeTurfScore(
  reach: number,
  rank: number | null
): number {
  const r = rank ?? 0;
  const raw = reach * (r / 3);
  return Math.max(0, Math.min(100, Math.round(raw)));
}
