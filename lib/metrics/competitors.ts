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
 * Returns the top N (default 3) by AMR, ascending. Optionally excludes the
 * client's own business by name pattern.
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
    .sort((a, b) => a.amr - b.amr)
    .slice(0, topN);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
