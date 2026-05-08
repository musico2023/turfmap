/**
 * Aggregate competitor stats from a scan's per-point local_pack data.
 *
 * For each unique competitor name observed across all scan points:
 *   - amr      : average rank (1-3) at the points where they appeared
 *   - top3Pct  : (appearances / totalPoints) × 100, rounded
 *
 * Per-cell dedupe: a single competitor only counts ONCE per grid cell
 * even when DFS returns the same business across multiple item types
 * (e.g. local_pack + map). Without this, share-of-voice could exceed
 * 100% — caught in production after a Toronto donut shop's COPS
 * competitor came back as 300% share. We use the BEST (lowest) rank
 * for the cell when the same brand appears multiple times in one
 * cell's response, mirroring the curated-list path's behavior.
 *
 * Ranking + noise floor:
 *
 *   Brands appearing in fewer than `MIN_SHARE_PCT`% of cells are
 *   filtered out as noise. A single-cell hit at rank #1 ties for the
 *   "best" AMR with a brand that dominates 48% of the territory at
 *   AMR 1.4 — but the 1-cell brand is almost always a Google-pin
 *   proximity artifact, not a real competitor. Default floor: 2%
 *   (≥ 2 cells out of 81), which excludes single-pin artifacts but
 *   keeps any brand with even a small but non-trivial territory
 *   presence.
 *
 *   After filtering, results sort by share DESC (territorial
 *   dominance is the primary signal for "who's eating my lunch?"),
 *   with AMR ASC as the tiebreaker — so two brands at the same
 *   share are ordered by who lands at the top of the pack more
 *   often when they do appear.
 *
 *   This auto-mode path differs from `aggregateCuratedCompetitors`,
 *   which has no noise filter (operator-chosen brands surface even
 *   at 0% share — that's part of the value of curated mode).
 *
 * Returns the top N (default 3). Optionally excludes the client's
 * own business by name pattern.
 */

export type RawCompetitor = {
  name?: string | null;
  rank_group?: number | null;
  rank_absolute?: number | null;
  domain?: string | null;
  place_id?: string | null;
};

export type CompetitorAggregate = {
  name: string;
  amr: number;
  top3Pct: number;
};

/**
 * Minimum share-of-voice (% of cells) for a brand to surface in
 * auto-discovery mode. Brands below this floor are almost always
 * Google-pin proximity artifacts (a business whose Google location
 * happens to sit on top of a single grid cell). Exposed for the
 * AI Coach prompt to apply the same filter when describing the
 * competitive set to Claude — drift between what the table shows
 * and what the Coach references would be confusing.
 */
export const MIN_SHARE_PCT = 2;

export function aggregateCompetitors(
  scanPoints: Array<{ competitors: unknown }>,
  totalPoints: number,
  options: { excludeNamePattern?: RegExp; topN?: number } = {}
): CompetitorAggregate[] {
  const { excludeNamePattern, topN = 3 } = options;
  const stats = new Map<string, number[]>();

  for (const sp of scanPoints) {
    const list = (sp.competitors ?? []) as RawCompetitor[];
    // Best rank per competitor within this single cell — handles
    // duplicate entries that DFS sometimes returns (same business
    // across local_pack + map item types). Without this, share-of-
    // voice can exceed 100%.
    const cellBest = new Map<string, number>();
    for (const c of list) {
      if (!c?.name) continue;
      if (excludeNamePattern && excludeNamePattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const prev = cellBest.get(c.name);
      if (prev === undefined || rank < prev) cellBest.set(c.name, rank);
    }
    for (const [name, rank] of cellBest.entries()) {
      const ranks = stats.get(name) ?? [];
      ranks.push(rank);
      stats.set(name, ranks);
    }
  }

  const safeTotal = Math.max(totalPoints, 1);
  return [...stats.entries()]
    .map(([name, ranks]) => ({
      name,
      amr: round1(ranks.reduce((a, b) => a + b, 0) / ranks.length),
      // Defensive clamp at 100 — the per-cell dedupe above guarantees
      // ranks.length ≤ totalPoints, but the clamp protects against
      // future regressions or pathological DFS payloads.
      top3Pct: Math.min(
        100,
        Math.round((ranks.length / safeTotal) * 100)
      ),
    }))
    // Noise floor — see MIN_SHARE_PCT docs. A 1-cell hit at rank #1
    // ties on AMR with a brand at 48% share, but it's a Google-pin
    // proximity artifact, not a real competitor.
    .filter((c) => c.top3Pct >= MIN_SHARE_PCT)
    // Sort by territorial dominance first (share desc), tiebreak on
    // average rank (lower is better). This matches operator intuition:
    // "who's eating my lunch?" → the brand with the most cells in
    // the 3-pack at the highest average rank.
    .sort((a, b) => {
      if (a.top3Pct !== b.top3Pct) return b.top3Pct - a.top3Pct;
      return a.amr - b.amr;
    })
    .slice(0, topN);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
