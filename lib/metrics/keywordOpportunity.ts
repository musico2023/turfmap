/**
 * Keyword Opportunity Finder — cross-keyword ranking.
 *
 * Given the latest performance of every keyword a location tracks, classify
 * each into an action tier and surface the single best opening — so the
 * operator stops spreading effort evenly and focuses the keyword that's
 * closest to breaking through. Mirrors the "wrong battle vs winnable"
 * framing the AI Coach's cross-keyword section uses.
 *
 * Rank-based only — we don't capture per-keyword search volume (see the
 * DataForSEO integration notes), so "opportunity" means winnable map upside,
 * not absolute search demand.
 *
 * Pure + testable (scripts/verify-keyword-opportunity.ts). No I/O.
 */

/** Reach at/above which a keyword is effectively won — defend, don't chase. */
const DEFEND_REACH = 60;
/** Reach at/above which a keyword has a real foothold worth pushing. */
const PUSH_REACH = 15;
/** Reach below which (but > 0) a keyword is still being built. */
const BUILD_REACH = 1;

export type KeywordPerf = {
  keyword: string;
  isPrimary: boolean;
  /** 0–100 composite from the latest complete scan, or null if never scanned. */
  turfScore: number | null;
  /** 0–100 % of cells in the 3-pack. */
  turfReach: number | null;
  /** 0–3 rank quality where present, or null. */
  turfRank: number | null;
};

export type KeywordOpportunityTier = 'defend' | 'push' | 'build' | 'reconsider';

export type KeywordOpportunityEntry = KeywordPerf & {
  tier: KeywordOpportunityTier;
  /** short human label for the tier in this keyword's context. */
  label: string;
};

export type KeywordOpportunityResult = {
  /** every keyword, sorted best-opportunity first. */
  keywords: KeywordOpportunityEntry[];
  /** the single keyword to focus next (best push, else best build), or null. */
  topOpportunity: KeywordOpportunityEntry | null;
  /** keywords stuck at zero reach — candidates to drop or replace. */
  dead: string[];
  headline: string;
};

function classify(reach: number): KeywordOpportunityTier {
  if (reach >= DEFEND_REACH) return 'defend';
  if (reach >= PUSH_REACH) return 'push';
  if (reach >= BUILD_REACH) return 'build';
  return 'reconsider';
}

const TIER_LABEL: Record<KeywordOpportunityTier, string> = {
  defend: 'Winning — defend',
  push: 'Winnable — push',
  build: 'Early — building',
  reconsider: 'Stuck — reconsider',
};

/** Sort priority: push first (closest to winning), then build, then defend
 *  (already won), then reconsider (dead). Within a tier, higher reach first. */
const TIER_ORDER: Record<KeywordOpportunityTier, number> = {
  push: 0,
  build: 1,
  defend: 2,
  reconsider: 3,
};

export function rankKeywordOpportunities(
  perf: KeywordPerf[]
): KeywordOpportunityResult | null {
  // Cross-keyword comparison only makes sense with more than one keyword.
  if (perf.length <= 1) return null;

  const entries: KeywordOpportunityEntry[] = perf
    .map((k) => {
      const reach = k.turfReach ?? 0;
      const tier = classify(reach);
      return { ...k, tier, label: TIER_LABEL[tier] };
    })
    .sort((a, b) => {
      const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (t !== 0) return t;
      return (b.turfReach ?? 0) - (a.turfReach ?? 0);
    });

  const topOpportunity =
    entries.find((e) => e.tier === 'push') ??
    entries.find((e) => e.tier === 'build') ??
    null;

  const dead = entries.filter((e) => e.tier === 'reconsider').map((e) => e.keyword);

  return {
    keywords: entries,
    topOpportunity,
    dead,
    headline: buildHeadline(entries, topOpportunity, dead),
  };
}

function buildHeadline(
  entries: KeywordOpportunityEntry[],
  top: KeywordOpportunityEntry | null,
  dead: string[]
): string {
  if (top) {
    const reach = top.turfReach ?? 0;
    const deadNote =
      dead.length > 0
        ? ` Drop or rework ${dead.length === 1 ? `"${dead[0]}"` : `${dead.length} stuck keywords`}.`
        : '';
    return `Focus "${top.keyword}" — ${reach}% reach and the closest to the 3-pack.${deadNote}`;
  }
  if (entries.every((e) => e.tier === 'defend')) {
    return `You're winning every tracked keyword — hold position and add new queries to expand.`;
  }
  if (dead.length === entries.length) {
    return `No keyword has traction yet — these are the wrong battles; reconsider the target queries.`;
  }
  return `Hold your winning keywords and rework the ${dead.length} that are stuck at zero.`;
}
