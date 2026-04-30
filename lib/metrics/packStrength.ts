/**
 * Pack Strength — 0–100 score measuring how well the business ranks at
 * the cells where it actually appears in the local 3-pack. The
 * complement to TurfScore: where TurfScore is dominated by territorial
 * coverage (out-of-pack cells take a max penalty and crush the average),
 * Pack Strength tells you how strong the business is where it's
 * visible — independent of how much of the territory it covers.
 *
 * Formula: average rank across cells in the 3-pack (1, 2, or 3),
 * converted via the same 100 − 5×avg pattern used for TurfScore so the
 * two metrics share a scale.
 *
 *   All present cells at #1     → strength 95
 *   All present cells at #2     → strength 90
 *   Mix of #1/#2 (avg 1.4)      → strength 93
 *   All present cells at #3     → strength 85
 *
 * Returns null when the business doesn't appear in any cell — the
 * dashboard renders that as "—" rather than 0 or 100, both of which
 * would be wrong (we have no data to score).
 *
 * The pitch utility: a client with low TurfScore (limited reach) but
 * high Pack Strength (wins where present) gets the "expand reach
 * without sacrificing rank" story; one with both low gets the
 * "fundamental prominence work first" story.
 */

export function packStrength(ranks: Array<number | null>): number | null {
  const inPack = ranks.filter((r): r is number => r !== null);
  if (inPack.length === 0) return null;
  const avg = inPack.reduce((a, b) => a + b, 0) / inPack.length;
  return Math.max(0, Math.min(100, Math.round(100 - 5 * avg)));
}
