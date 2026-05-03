/**
 * Benchmark bands for TurfScore — the canonical mapping from a 0-100
 * score to a categorical label + tone, used in the dashboard, the
 * client portal, the PDF report, the AI Coach prompt, and the
 * marketing site. Single source of truth lives here.
 *
 * Bands (inclusive lower bound, exclusive upper):
 *   [ 0, 20)  → "Invisible"   (critical)
 *   [20, 40)  → "Patchy"      (weak)
 *   [40, 60)  → "Solid"       (solid)
 *   [60, 80)  → "Dominant"    (strong)
 *   [80, 100] → "Rare air"    (elite)
 *
 * The `tone` value is consumed by the UI to pick a color treatment
 * — keep semantics here loose ("critical/weak/solid/strong/elite")
 * so callers can map to whatever palette they need (lime/yellow/
 * orange/red on the dashboard, grayscale on the PDF, etc.).
 */

export type TurfScoreBandTone =
  | 'critical'
  | 'weak'
  | 'solid'
  | 'strong'
  | 'elite';

export type TurfScoreBand = {
  label: string;
  range: string;
  tone: TurfScoreBandTone;
};

export function getTurfScoreBand(score: number): TurfScoreBand {
  if (!Number.isFinite(score)) return INVISIBLE;
  if (score >= 80) return RARE_AIR;
  if (score >= 60) return DOMINANT;
  if (score >= 40) return SOLID;
  if (score >= 20) return PATCHY;
  return INVISIBLE;
}

const INVISIBLE: TurfScoreBand = {
  label: 'Invisible',
  range: '0–20',
  tone: 'critical',
};
const PATCHY: TurfScoreBand = {
  label: 'Patchy',
  range: '20–40',
  tone: 'weak',
};
const SOLID: TurfScoreBand = {
  label: 'Solid',
  range: '40–60',
  tone: 'solid',
};
const DOMINANT: TurfScoreBand = {
  label: 'Dominant',
  range: '60–80',
  tone: 'strong',
};
const RARE_AIR: TurfScoreBand = {
  label: 'Rare air',
  range: '80+',
  tone: 'elite',
};

/** All bands in ascending order — useful for legends and marketing copy. */
export const TURF_SCORE_BANDS: readonly TurfScoreBand[] = [
  INVISIBLE,
  PATCHY,
  SOLID,
  DOMINANT,
  RARE_AIR,
];
