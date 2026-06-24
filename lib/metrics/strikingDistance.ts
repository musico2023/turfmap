/**
 * Striking distance — how close a keyword's map is to winning more cells.
 *
 * In geo-grid terms, a cell where the client ranks 4–10 is "striking
 * distance": just outside the 3-pack, one or two positions from visible.
 * Cells at rank 4–6 ("near pack") are the quickest wins. Surfacing this
 * turns a flat reach number into an actionable "X% of your map is one
 * nudge from the pack" opportunity — the core of the Keyword Opportunity
 * Finder, and it works even for single-keyword locations.
 *
 * Pure + testable (scripts/verify-keyword-opportunity.ts). No I/O.
 */

/** Highest rank still considered "near pack" — the quickest cells to flip. */
export const NEAR_PACK_MAX = 6;
/** Highest rank considered "striking distance" (just outside the pack). */
export const STRIKING_MAX = 10;

export type StrikingDistanceResult = {
  /** total cells with a usable rank (null/absent cells excluded). */
  ranked: number;
  /** cells where the client is in the 3-pack (rank 1–3). */
  inPack: number;
  /** cells at rank 4–10 (just outside the pack). */
  striking: number;
  /** cells at rank 4–6 (the quickest wins). */
  nearPack: number;
  /** striking cells as % of the FULL grid (not just ranked cells). */
  strikingPct: number;
  /** near-pack cells as % of the full grid. */
  nearPackPct: number;
};

export function strikingDistance(
  ranks: Array<number | null>,
  totalCells: number = ranks.length
): StrikingDistanceResult {
  const total = Math.max(totalCells, 1);
  let ranked = 0;
  let inPack = 0;
  let striking = 0;
  let nearPack = 0;

  for (const r of ranks) {
    if (r == null || r < 1) continue;
    ranked += 1;
    if (r <= 3) {
      inPack += 1;
    } else if (r <= STRIKING_MAX) {
      striking += 1;
      if (r <= NEAR_PACK_MAX) nearPack += 1;
    }
  }

  return {
    ranked,
    inPack,
    striking,
    nearPack,
    strikingPct: Math.round((striking / total) * 100),
    nearPackPct: Math.round((nearPack / total) * 100),
  };
}
