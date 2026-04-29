/**
 * Aggregate competitor stats from a scan's per-point local_pack data.
 *
 * For each unique competitor name observed across all scan points:
 *   - amr      : average rank (1-3) at the points where they appeared
 *   - top3Pct  : (appearances / totalPoints) × 100, rounded
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
    for (const c of list) {
      if (!c?.name) continue;
      if (excludeNamePattern && excludeNamePattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const ranks = stats.get(c.name) ?? [];
      ranks.push(rank);
      stats.set(c.name, ranks);
    }
  }

  return [...stats.entries()]
    .map(([name, ranks]) => ({
      name,
      amr: round1(ranks.reduce((a, b) => a + b, 0) / ranks.length),
      top3Pct: Math.round((ranks.length / Math.max(totalPoints, 1)) * 100),
    }))
    .sort((a, b) => a.amr - b.amr)
    .slice(0, topN);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
