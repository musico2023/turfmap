/**
 * TurfRadius — the largest concentric ring (in grid units, from the center
 * cell at (4,4) on a 9×9 grid) where the *average* rank within that ring is
 * still in the local 3-pack (≤ 3.5).
 *
 * In practice this answers: "how far from your pin do you still dominate
 * the local pack on average?" Returned as an integer 0-5; multiply by the
 * grid spacing in miles to get a real-world radius.
 *
 * Spacing for the default 9×9 / 1.6mi config is 0.4 mi per ring.
 */

import type { GridPoint } from '../dataforseo/grid';

const TOP3_AVG_THRESHOLD = 3.5;

export type RadiusInput = {
  point: Pick<GridPoint, 'x' | 'y'>;
  rank: number | null;
};

export function turfRadius(
  cells: RadiusInput[],
  gridSize = 9,
  outOfPackRank = 20
): number {
  if (!cells.length) return 0;
  const center = (gridSize - 1) / 2;
  let lastGoodRing = 0;

  for (let r = 0; r <= Math.ceil(center); r++) {
    const ring = cells.filter((c) => {
      const dist = Math.round(
        Math.sqrt((c.point.x - center) ** 2 + (c.point.y - center) ** 2)
      );
      return dist === r;
    });
    if (!ring.length) continue;
    const avg =
      ring.reduce((acc, c) => acc + (c.rank ?? outOfPackRank), 0) / ring.length;
    if (avg <= TOP3_AVG_THRESHOLD) lastGoodRing = r;
  }
  return lastGoodRing;
}
