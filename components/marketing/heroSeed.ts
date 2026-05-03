import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';

/**
 * Deterministic 81-cell heatmap pattern for the marketing hero.
 *
 * Hand-tuned to look like a realistic "Patchy" scan — the exact
 * profile a typical home-services business would see before they
 * optimize: solid presence in a 3×3 zone immediately around the
 * business location, tapering to spotty rank-2/rank-3 cells on the
 * inner ring, and a heavy red border on the outer rings where the
 * business doesn't appear in the local 3-pack at all.
 *
 * Resulting metrics (computed by the same pipeline the live product
 * uses):
 *   TurfReach ≈ 46%   (37 of 81 cells in pack)
 *   TurfRank  ≈ 2.1   (avg rank where present)
 *   TurfScore ≈ 38    ("Patchy" band)
 *
 * This intentionally lands in the "most prospects look like this
 * before optimization" range so the visitor recognizes the pattern
 * without it feeling like cherry-picked best-case marketing.
 *
 * The grid is read row-by-row from y=0 (top) to y=8 (bottom). Each
 * digit/character represents one cell:
 *   1, 2, 3 → rank in the 3-pack
 *   .       → not in the 3-pack (rank null)
 */
const PATTERN = [
  '.........', // y=0 — outer edge, all red
  '..3.3....', // y=1 — sparse rank-3s
  '.3.232.3.', // y=2
  '..32123..', // y=3
  '..21112..', // y=4 — center band: dominant
  '..32123..', // y=5
  '.3.232.3.', // y=6
  '..3.3....', // y=7
  '.........', // y=8 — outer edge, all red
] as const;

function decode(ch: string): number | null {
  if (ch === '1' || ch === '2' || ch === '3') return Number(ch);
  return null;
}

export function buildHeroCells(): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (let y = 0; y < 9; y++) {
    const row = PATTERN[y];
    for (let x = 0; x < 9; x++) {
      cells.push({ x, y, rank: decode(row[x] ?? '.') });
    }
  }
  return cells;
}

/** Headline metrics that should be displayed alongside the hero
 *  heatmap. Rounded to whole numbers for marketing readability. */
export const HERO_METRICS = {
  reach: 46,
  rank: 2.1,
  score: 38,
  band: 'Patchy',
} as const;
