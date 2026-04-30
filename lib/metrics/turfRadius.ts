/**
 * TurfRadius — Chebyshev distance (in grid rings, where 1 ring = 1 cell of
 * spacing) from the center cell to the *furthest* cell where the business
 * appears in the local 3-pack at all.
 *
 * In plain English: "how far from your pin do you reach the 3-pack."
 * Multiply by the grid's miles-per-ring to get a real-world distance.
 *
 * Why max-reach instead of "ring with avg rank ≤ 3.5":
 *   The old definition broke for non-circular coverage patterns. A client
 *   with strong rank-1 cells in a vertical strip (downtown corridor) but
 *   gaps to the east/west would return 0 ("no consistent ring"), even
 *   though they clearly reach 4 rings out from the pin in the strong
 *   direction. The pitch story should reflect the reach, not the ring
 *   averaging artifact. Returns 0 cleanly for clients with zero presence.
 *
 * Chebyshev distance is the right ring metric for a square grid: cells
 * at (x,y) lie at distance max(|dx|, |dy|) rings from the center.
 */

import type { GridPoint } from '../dataforseo/grid';

const IN_PACK_THRESHOLD = 3;

export type RadiusInput = {
  point: Pick<GridPoint, 'x' | 'y'>;
  rank: number | null;
};

export function turfRadius(
  cells: RadiusInput[],
  gridSize = 9,
  // Kept for backward-compat call sites; unused now that we don't
  // average ranks across rings.
  _outOfPackRank = 20
): number {
  if (!cells.length) return 0;
  const center = (gridSize - 1) / 2;
  let maxRing = 0;
  for (const c of cells) {
    if (c.rank === null || c.rank > IN_PACK_THRESHOLD) continue;
    const ring = Math.max(
      Math.abs(c.point.x - center),
      Math.abs(c.point.y - center)
    );
    if (ring > maxRing) maxRing = ring;
  }
  return maxRing;
}
