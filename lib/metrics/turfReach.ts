/**
 * TurfReach — coverage metric, 0-100.
 *
 * The percentage of grid cells where the business appears in Google's
 * local 3-pack at all.
 *
 * Formula: cells_in_pack / total_cells × 100
 *   where cells_in_pack = ranks where rank is 1, 2, or 3
 *   total_cells = the full grid size (typically 81 for 9×9)
 *
 *   ranks = [1, null, 2, null, null, 3]   reach = 50
 *   ranks = [1, 1, 1, 1, 1]               reach = 100
 *   ranks = [null, null, null]            reach = 0
 *
 * Replaces the prior `top3Rate` helper. Same underlying math, renamed
 * to align with the public-marketing taxonomy (TurfScore family).
 */

export function turfReach(
  ranks: Array<number | null>,
  totalCells: number = 81
): number {
  if (totalCells <= 0) return 0;
  const inPack = ranks.filter((r): r is number => r !== null && r >= 1 && r <= 3).length;
  return Math.round((inPack / totalCells) * 100);
}
