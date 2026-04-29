/**
 * TurfScore = Average Map Rank (AMR) across all 81 grid points.
 *
 * Lower is better. Convention: a point that's NOT in the local 3-pack at all
 * is treated as `OUT_OF_PACK_RANK` (default 20) — heavy penalty, but not
 * infinite, so the average stays interpretable. The exact penalty is a knob;
 * 20 is the industry-default for "not visible in the local pack."
 */

export const OUT_OF_PACK_RANK = 20;

export function turfScore(
  ranks: Array<number | null>,
  outOfPackRank = OUT_OF_PACK_RANK
): number | null {
  if (!ranks.length) return null;
  const adjusted = ranks.map((r) => (r === null ? outOfPackRank : r));
  const sum = adjusted.reduce((a, b) => a + b, 0);
  return roundTo(sum / adjusted.length, 1);
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
