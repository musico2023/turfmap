/**
 * Competitor Intel — Pulse+ dashboard metric.
 *
 * Turns a scan's per-cell competitor data into a ranked "who's beating you
 * and on what lever" view: each top competitor's grid share, average map
 * rank (AMR), GBP rating + review count, and the GAP vs the client. The
 * dashboard CompetitorTable already shows share + AMR; this adds the
 * prominence deltas (reviews, rating) the AI Coach leads with, so the
 * client can see *why* a competitor outranks them, not just that they do.
 *
 * Pure + testable (scripts/verify-competitor-intel.ts). No I/O.
 *
 * Aggregation mirrors lib/ai-coach/generateInsight.ts (the hardened path,
 * commit dd1aaf6): per-cell dedupe keeping the best in-pack rank, and the
 * rating tied to the HIGHEST-review-count snapshot so one anomalous cell
 * can't skew it. Kept as a separate pure fn (not imported from the coach)
 * because the coach computes it inline at scan time; this runs on the
 * dashboard render path over already-loaded points.
 */

/** Minimum grid share (% of cells in the 3-pack) for a competitor to
 *  surface — filters one-off appearances. Matches the coach's floor. */
const MIN_SHARE_PCT = 5;

export type CompetitorIntelPoint = {
  /** the client's own rank in this cell (1–3 in pack, else out/absent). */
  rank: number | null;
  /** raw competitor array from scan_points.competitors (jsonb). */
  competitors: unknown;
};

export type CompetitorIntelInput = {
  points: CompetitorIntelPoint[];
  /** the client's own business — name (for self-exclusion) + GBP signals. */
  own: { name: string; rating: number | null; reviews: number | null };
  /** total cells in the grid; defaults to points.length (81). */
  totalCells?: number;
  /** how many top competitors to return. */
  topN?: number;
};

export type CompetitorIntelEntry = {
  name: string;
  /** % of cells where this competitor appeared in the 3-pack. */
  sharePct: number;
  /** average map rank (1–3) across cells where present. */
  amr: number;
  /** best (lowest) rank seen anywhere. */
  bestRank: number;
  /** number of cells they appeared in. */
  appearances: number;
  rating: number | null;
  reviews: number | null;
  /** competitor reviews − own reviews (null if either unknown). Positive
   *  = competitor has more (a gap to close). */
  reviewGap: number | null;
  /** competitor rating − own rating (null if either unknown). */
  ratingDelta: number | null;
  /** competitor share − own share, in percentage points. */
  shareGap: number;
};

export type CompetitorIntelResult = {
  own: { sharePct: number; rating: number | null; reviews: number | null };
  competitors: CompetitorIntelEntry[];
  /** the top competitor by grid share, or null when none surface. */
  leader: CompetitorIntelEntry | null;
  /** mean review count across the surfaced competitors minus own reviews —
   *  the headline "reviews lever" gap (null when own reviews unknown). */
  reviewGapToField: number | null;
  /** one-line plain-English takeaway for the card header. */
  headline: string;
};

type RawComp = {
  name?: string | null;
  rank_group?: number | null;
  rank_absolute?: number | null;
  rating?: number | null;
  reviews?: number | null;
};

export function computeCompetitorIntel(
  input: CompetitorIntelInput
): CompetitorIntelResult | null {
  const { points, own } = input;
  const totalCells = Math.max(input.totalCells ?? points.length, 1);
  const topN = input.topN ?? 4;
  const ownNamePattern = new RegExp(
    escapeRegex(own.name.split(/\s+/)[0] ?? ''),
    'i'
  );

  // Own grid share: cells where the client sits in the 3-pack.
  const ownInPack = points.filter(
    (p) => p.rank != null && p.rank >= 1 && p.rank <= 3
  ).length;
  const ownSharePct = Math.round((ownInPack / totalCells) * 100);

  type Stats = { ranks: number[]; rating: number | null; reviews: number | null };
  const compStats = new Map<string, Stats>();

  for (const p of points) {
    const list = (Array.isArray(p.competitors) ? p.competitors : []) as RawComp[];
    const cellBest = new Map<string, number>();
    const cellSignals = new Map<string, { rating: number | null; reviews: number | null }>();

    for (const c of list) {
      if (!c?.name) continue;
      if (ownNamePattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const prev = cellBest.get(c.name);
      if (prev === undefined || rank < prev) cellBest.set(c.name, rank);
      cellSignals.set(c.name, { rating: c.rating ?? null, reviews: c.reviews ?? null });
    }

    for (const [name, rank] of cellBest.entries()) {
      const s = compStats.get(name) ?? { ranks: [], rating: null, reviews: null };
      s.ranks.push(rank);
      // Hardened: keep the rating tied to the highest review-count snapshot;
      // fall back to any rating when no review count is available.
      const sig = cellSignals.get(name);
      if (sig) {
        if (sig.reviews != null && (s.reviews == null || sig.reviews > s.reviews)) {
          s.reviews = sig.reviews;
          if (sig.rating != null) s.rating = sig.rating;
        } else if (s.reviews == null && s.rating == null && sig.rating != null) {
          s.rating = sig.rating;
        }
      }
      compStats.set(name, s);
    }
  }

  const competitors: CompetitorIntelEntry[] = [...compStats.entries()]
    .map(([name, s]) => {
      const sharePct = Math.round((s.ranks.length / totalCells) * 100);
      const amr =
        Math.round((s.ranks.reduce((a, b) => a + b, 0) / s.ranks.length) * 10) / 10;
      return {
        name,
        sharePct,
        amr,
        bestRank: Math.min(...s.ranks),
        appearances: s.ranks.length,
        rating: s.rating,
        reviews: s.reviews,
        reviewGap:
          s.reviews != null && own.reviews != null ? s.reviews - own.reviews : null,
        ratingDelta:
          s.rating != null && own.rating != null
            ? Math.round((s.rating - own.rating) * 10) / 10
            : null,
        shareGap: sharePct - ownSharePct,
      };
    })
    .filter((c) => c.sharePct >= MIN_SHARE_PCT)
    .sort((a, b) => b.sharePct - a.sharePct || a.amr - b.amr)
    .slice(0, topN);

  if (competitors.length === 0) return null;

  const leader = competitors[0];

  // Reviews lever: how far the client trails the surfaced field on reviews.
  const withReviews = competitors.filter((c) => c.reviews != null);
  const fieldMeanReviews =
    withReviews.length > 0
      ? Math.round(
          withReviews.reduce((a, c) => a + (c.reviews ?? 0), 0) / withReviews.length
        )
      : null;
  const reviewGapToField =
    fieldMeanReviews != null && own.reviews != null
      ? fieldMeanReviews - own.reviews
      : null;

  const headline = buildHeadline({
    leader,
    ownSharePct,
    reviewGapToField,
    ownReviews: own.reviews,
  });

  return {
    own: { sharePct: ownSharePct, rating: own.rating, reviews: own.reviews },
    competitors,
    leader,
    reviewGapToField,
    headline,
  };
}

function buildHeadline(args: {
  leader: CompetitorIntelEntry;
  ownSharePct: number;
  reviewGapToField: number | null;
  ownReviews: number | null;
}): string {
  const { leader, ownSharePct, reviewGapToField } = args;
  const shareLead = leader.sharePct - ownSharePct;
  // Lead with the territorial gap when a competitor clearly dominates the
  // map; otherwise lead with the reviews lever when it's the bigger story.
  if (shareLead >= 15) {
    return `${leader.name} holds ${leader.sharePct}% of your map vs your ${ownSharePct}% — the leader to displace.`;
  }
  if (reviewGapToField != null && reviewGapToField >= 100) {
    return `You're competitive on the map, but the field averages ${reviewGapToField.toLocaleString()} more reviews — close that to pull ahead.`;
  }
  if (ownSharePct >= leader.sharePct) {
    return `You lead the map (${ownSharePct}% vs ${leader.name}'s ${leader.sharePct}%) — defend it and watch the reviews gap.`;
  }
  return `${leader.name} edges you on the map (${leader.sharePct}% vs ${ownSharePct}%) — a winnable gap.`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
