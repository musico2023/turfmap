/**
 * Curated competitor leaderboard.
 *
 * Unlike `aggregateCompetitors` (which discovers top-N competitors dynamically
 * from raw scan data), this function takes a hand-picked brand list and
 * computes (amr, top3Pct, appearsInCells) for every brand — including ones
 * that didn't surface anywhere. Brands are matched against scan_point
 * competitor names by case-insensitive substring, which collapses franchise
 * locations ("Home Instead - Alexandria" + "Home Instead - Arlington" both
 * roll up into "Home Instead").
 *
 * Used by the client dashboard whenever the `competitors` table has rows for
 * the client (i.e. the agency has explicitly told us who to track for them).
 */
import type { RawCompetitor } from './competitors';

export type CuratedCompetitorAggregate = {
  /** Brand-root name as stored in the `competitors` table. */
  name: string;
  /** Avg rank across cells where this brand appeared. 20 if zero appearances (out-of-pack penalty). */
  amr: number;
  /** % of total points where this brand was in the local 3-pack. */
  top3Pct: number;
  /** Raw count of cells where this brand appeared. */
  appearsInCells: number;
};

const OUT_OF_PACK = 20;

export function aggregateCuratedCompetitors(
  scanPoints: Array<{ competitors: unknown }>,
  brandNames: string[],
  totalPoints: number
): CuratedCompetitorAggregate[] {
  // brand → array of best-rank-per-cell
  const ranksByBrand = new Map<string, number[]>();
  const normalized = brandNames.map((b) => ({
    name: b,
    needle: b.toLowerCase(),
  }));
  for (const b of normalized) ranksByBrand.set(b.name, []);

  for (const sp of scanPoints) {
    const list = (sp.competitors ?? []) as RawCompetitor[];
    // best rank per brand within this single cell (handles two same-brand
    // listings showing up in the same cell, which is rare but possible).
    const cellBest = new Map<string, number>();
    for (const item of list) {
      if (!item?.name) continue;
      const haystack = item.name.toLowerCase();
      const rank =
        typeof item.rank_group === 'number'
          ? item.rank_group
          : typeof item.rank_absolute === 'number'
            ? item.rank_absolute
            : null;
      if (rank === null || rank > 3) continue; // local pack only goes 1-3
      for (const b of normalized) {
        if (haystack.includes(b.needle)) {
          const prev = cellBest.get(b.name);
          if (prev === undefined || rank < prev) cellBest.set(b.name, rank);
          break; // first matching brand wins
        }
      }
    }
    for (const [brand, rank] of cellBest.entries()) {
      ranksByBrand.get(brand)!.push(rank);
    }
  }

  const safeTotal = Math.max(totalPoints, 1);
  return [...ranksByBrand.entries()]
    .map(([name, ranks]) => {
      if (ranks.length === 0) {
        return { name, amr: OUT_OF_PACK, top3Pct: 0, appearsInCells: 0 };
      }
      const amr = round1(ranks.reduce((a, b) => a + b, 0) / ranks.length);
      const top3Pct = Math.round((ranks.length / safeTotal) * 100);
      return { name, amr, top3Pct, appearsInCells: ranks.length };
    })
    .sort((a, b) => {
      // primary: amr asc; secondary: appearsInCells desc (so a brand that's
      // present everywhere outranks a brand present in 1 cell at rank 1)
      if (a.amr !== b.amr) return a.amr - b.amr;
      return b.appearsInCells - a.appearsInCells;
    });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
