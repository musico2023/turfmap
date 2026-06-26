/**
 * Competitor Keyword Reveal — v1 builder (Phase B).
 *
 * From a completed free scan, surface the keyword gap that drives the
 * free→paid conversion: "your top competitor ranks for N service searches
 * across your area; you're mapped on 1." Pipeline:
 *
 *   scan_points.competitors → #1 competitor by grid share (+ its domain)
 *     → DFS keywords_for_site (cached by domain)
 *     → intersect with this business's local-intent candidate set
 *     → local-pack gate each candidate (grid-eligibility)
 *     → persist keyword_candidates for the /share reveal
 *
 * Run in after() post-scan so it never delays the scan response. The two
 * core decisions (pick the competitor, intersect keywords) are pure +
 * guard-tested; the orchestrator does the I/O.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  keywordsForSite,
  localPackPresence,
  DFS_LOCATION_CODE,
  type CompetitorKeyword,
} from '@/lib/dataforseo/client';
import { rankLocalKeywordCandidates } from '@/lib/keywords/suggestions';
import type { KeywordCandidateRow } from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

/** Cache freshness — local keyword sets barely move. */
const CACHE_TTL_DAYS = 60;
/** Cap on candidates we local-pack-gate, to bound per-scan DFS spend. */
const GATE_CAP = 10;
/** Rows to pull from DFS Labs keywords_for_site. DFS bills per row. We
 *  intersect against ~6 service stems; the full 1000 catches a competitor's
 *  deeper-ranked service terms (≈12¢/first-touch, then cached by domain) for
 *  the richest reveal — the conversion driver. Measured: 1000→4 matches,
 *  200→2. Cache (60d TTL) amortizes the cost across a metro's repeat rivals. */
const LABS_LIMIT = 1000;
/** Minimum grid share for a competitor to be the reveal's anchor. */
const MIN_COMPETITOR_SHARE = 5;

export type RevealPoint = {
  rank: number | null;
  competitors: unknown;
};

export type TopCompetitor = {
  name: string;
  domain: string;
  sharePct: number;
  appearances: number;
};

type RawComp = {
  name?: string | null;
  domain?: string | null;
  rank_group?: number | null;
  rank_absolute?: number | null;
};

/**
 * Pick the strongest competitor to mine: highest grid share among rivals
 * that expose a domain (we can't mine a domain-less listing). Pure.
 */
export function pickTopCompetitor(
  points: RevealPoint[],
  ownName: string,
  totalCells: number = points.length
): TopCompetitor | null {
  const total = Math.max(totalCells, 1);
  const ownPattern = new RegExp(escapeRegex(ownName.split(/\s+/)[0] ?? ''), 'i');

  // name → { appearances, domain }. Dedup per cell (best in-pack rank).
  const agg = new Map<string, { appearances: number; domain: string | null }>();
  for (const p of points) {
    const list = (Array.isArray(p.competitors) ? p.competitors : []) as RawComp[];
    const cellBest = new Map<string, { rank: number; domain: string | null }>();
    for (const c of list) {
      if (!c?.name) continue;
      if (ownPattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const prev = cellBest.get(c.name);
      if (prev === undefined || rank < prev.rank) {
        cellBest.set(c.name, { rank, domain: c.domain ?? null });
      }
    }
    for (const [name, { domain }] of cellBest.entries()) {
      const cur = agg.get(name) ?? { appearances: 0, domain: null };
      cur.appearances += 1;
      if (!cur.domain && domain) cur.domain = domain;
      agg.set(name, cur);
    }
  }

  const ranked = [...agg.entries()]
    .map(([name, v]) => ({
      name,
      domain: cleanDomain(v.domain),
      appearances: v.appearances,
      sharePct: Math.round((v.appearances / total) * 100),
    }))
    .filter((c) => c.domain.length > 0 && c.sharePct >= MIN_COMPETITOR_SHARE)
    .sort((a, b) => b.appearances - a.appearances);

  const top = ranked[0];
  return top ? { name: top.name, domain: top.domain, sharePct: top.sharePct, appearances: top.appearances } : null;
}

/**
 * Mark which local-intent candidates a competitor ranks for. A candidate
 * matches when the competitor ranks for ANY keyword containing the
 * candidate's geo-independent service stem (the competitor's keywords
 * carry their own geo or none). Pure.
 */
export function markCompetitorRanked(
  candidateStems: string[],
  competitorKeywords: string[]
): Set<string> {
  const kws = competitorKeywords.map((k) => k.toLowerCase());
  const matched = new Set<string>();
  for (const stem of candidateStems) {
    const s = stem.toLowerCase();
    if (s.length >= 3 && kws.some((k) => k.includes(s))) matched.add(stem);
  }
  return matched;
}

export type RevealResult = {
  topCompetitor: TopCompetitor | null;
  candidateCount: number;
  competitorRankedCount: number;
  /** DFS spend for this build (Labs + gate) in integer cents. */
  costCents: number;
  /** True when the Labs result came from cache (no Labs spend). */
  cacheHit: boolean;
};

export type BuildRevealInput = {
  scanId: string;
  ownName: string;
  industry: string | null;
  city: string | null;
  lat: number;
  lng: number;
  countryCode: string | null;
  scannedKeyword: string;
};

/**
 * Build + persist the reveal for one scan. Safe to re-run (upserts by
 * (scan_id, keyword)). Returns a summary incl. the DFS cost so the
 * dogfood / telemetry can verify unit economics.
 */
export async function buildCompetitorReveal(
  supabase: SupabaseLike,
  input: BuildRevealInput
): Promise<RevealResult> {
  // Accumulate in dollars (full precision) and round to cents once at the
  // end — per-call rounding loses sub-cent gate calls ($0.002 → 0.2¢ → 0).
  let costDollars = 0;
  let cacheHit = false;

  const { data: points } = await supabase
    .from('scan_points')
    .select('rank, competitors')
    .eq('scan_id', input.scanId)
    .returns<RevealPoint[]>();

  const top = pickTopCompetitor(points ?? [], input.ownName);

  const candidates = rankLocalKeywordCandidates(input.industry, input.city, {
    limit: GATE_CAP,
  });

  // ── Competitor mining (cached by domain) ──
  let competitorKeywords: string[] = [];
  if (top) {
    const cutoffIso = new Date(
      Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: cached } = await supabase
      .from('competitor_keyword_cache')
      .select('payload, fetched_at')
      .eq('domain', top.domain)
      .gte('fetched_at', cutoffIso)
      .maybeSingle<{ payload: { keywords?: CompetitorKeyword[] }; fetched_at: string }>();

    if (cached?.payload?.keywords) {
      competitorKeywords = cached.payload.keywords.map((k) => k.keyword);
      cacheHit = true;
    } else {
      const locationCode =
        (input.countryCode ?? '').toUpperCase() === 'CAN'
          ? DFS_LOCATION_CODE.CAN
          : DFS_LOCATION_CODE.USA;
      const mined = await keywordsForSite(top.domain, {
        locationCode,
        limit: LABS_LIMIT,
      });
      costDollars += mined.costDollars;
      competitorKeywords = mined.keywords.map((k) => k.keyword);
      await supabase.from('competitor_keyword_cache').upsert(
        {
          domain: top.domain,
          payload: { keywords: mined.keywords },
          source_api: 'labs/keywords_for_site',
          fetch_cost_cents: Math.round(mined.costDollars * 100),
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'domain' }
      );
    }
  }

  const competitorRankedStems = markCompetitorRanked(
    candidates.map((c) => c.stem),
    competitorKeywords
  );

  // ── Local-pack gate each candidate (the scanned keyword is known-good) ──
  const scannedLc = input.scannedKeyword.trim().toLowerCase();
  const gated = new Map<string, boolean>();
  for (const c of candidates) {
    if (c.keyword === scannedLc) {
      gated.set(c.keyword, true); // it was just scanned — it has a pack
      continue;
    }
    const res = await localPackPresence(c.keyword, input.lat, input.lng);
    costDollars += res.costDollars;
    gated.set(c.keyword, res.present);
  }

  // ── Persist ──
  type CandidateInsert = Omit<KeywordCandidateRow, 'id' | 'created_at'>;
  const rows: CandidateInsert[] = candidates.map((c) => {
    const isScanned = c.keyword === scannedLc;
    const present = gated.get(c.keyword) ?? null;
    const competitorRanked = competitorRankedStems.has(c.stem);
    return {
      scan_id: input.scanId,
      keyword: c.keyword,
      stem: c.stem,
      intent: c.intent,
      local_pack_present: present,
      competitor_ranked: competitorRanked,
      competitor_domain: competitorRanked ? (top?.domain ?? null) : null,
      priority: c.priority,
      status: isScanned
        ? 'tracked'
        : present === false
          ? 'excluded_no_localpack'
          : 'suggested',
    };
  });

  // Ensure the scanned keyword is always present even if it wasn't in the
  // templated candidate set (e.g. the buyer typed a custom keyword).
  if (!rows.some((r) => r.keyword === scannedLc)) {
    rows.push({
      scan_id: input.scanId,
      keyword: scannedLc,
      stem: null,
      intent: 'service',
      local_pack_present: true,
      competitor_ranked: false,
      competitor_domain: null,
      priority: null,
      status: 'tracked',
    });
  }

  if (rows.length > 0) {
    await supabase
      .from('keyword_candidates')
      .upsert(rows, { onConflict: 'scan_id,keyword' });
  }

  return {
    topCompetitor: top,
    candidateCount: rows.length,
    competitorRankedCount: rows.filter((r) => r.competitor_ranked).length,
    costCents: Math.round(costDollars * 100),
    cacheHit,
  };
}

/** Normalize a domain: strip protocol, www, path, lowercase. */
function cleanDomain(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
