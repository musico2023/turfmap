/**
 * LLM Fit Score — deterministic 1-5 score deciding whether a Visibility
 * Audit buyer is a candidate for Local Lead Machine.
 *
 * Why deterministic / rules-based instead of LLM-driven: this score
 * gates the snippet that Anthony sends post-call ("LLM pitch" vs.
 * "audit only") + the qualification copy on Page 7 of the Roadmap PDF
 * + a Slack alert. Auditable and stable matters more here than nuance.
 * If we want to revise the rules, we revise this file + bump the
 * version below, not re-prompt Claude and hope.
 *
 * Inputs (all nullable — missing data = "we couldn't determine," not
 * "FALSE"):
 *
 *   revenueBand   — derived from Apollo enrichment when available,
 *                   else inferred from review count via the bands
 *                   in the spec ("100-300 reviews ≈ $50-150K/mo").
 *   tradeFit      — TRUE for the LLM-target verticals (HVAC, Roofing,
 *                   Plumbing, Electrical, Renovation, Restoration,
 *                   Landscaping, Windows & Doors).
 *   metroFit      — TRUE for major metros; FALSE for small markets
 *                   under ~100K population. NULL when we don't have
 *                   geocode-driven population data.
 *   adActive      — TRUE if Apify or Apollo signals show the business
 *                   is currently running Google or Meta ads.
 *   reviewCount   — raw GBP review count. Used as a secondary signal
 *                   even when revenueBand is provided directly.
 *
 * Score interpretation:
 *
 *   5 = Strong fit (revenue >$50K, trade fit, metro fit,
 *       ad-active OR review count >150)
 *   4 = Likely fit (most factors align)
 *   3 = Possible fit (revenue uncertain, trade and metro fit)
 *   2 = Weak fit (one or more disqualifiers)
 *   1 = Not fit (multiple disqualifiers — outside trade scope OR
 *       <$50K/mo signal OR small market)
 *
 * Returns the score + a breakdown of inputs + which named rules fired,
 * suitable for storing in visibility_audits.llm_fit_breakdown and
 * surfacing in the strategist prep notes.
 *
 * Versioned via LLM_FIT_SCORE_VERSION — bump on rule changes so we can
 * trace which scoring revision produced which historical score.
 */

import type { LlmFitBreakdown } from '@/lib/supabase/types';

export const LLM_FIT_SCORE_VERSION = 'llm_fit_v1';

/** LLM-target trades. Source: spec — these are the verticals where
 *  Fourdots' demand-generation playbook reliably converts at the
 *  $5,997 + $2,500/mo price point. */
export const LLM_TARGET_TRADES = [
  'hvac',
  'roofing',
  'plumbing',
  'electrical',
  'renovation',
  'restoration',
  'landscaping',
  'windows_doors',
] as const;

export type LlmTargetTrade = (typeof LLM_TARGET_TRADES)[number];

/** Inputs the score reads. All nullable so callers can pass partial
 *  data without lying about what they don't know. */
export type LlmFitInputs = {
  /** Direct revenue band when known. When NULL, we infer from
   *  reviewCount via inferRevenueBand(). */
  revenueBand?: 'low' | 'mid' | 'high' | null;
  /** TRUE for one of LLM_TARGET_TRADES; FALSE for outside-scope
   *  trades (e.g., dentists, restaurants, retail). NULL when we
   *  don't have a confident trade classification. */
  tradeFit?: boolean | null;
  /** TRUE for major metros (population ≥100K typically). NULL when
   *  no geocode-driven population data is available. */
  metroFit?: boolean | null;
  /** TRUE if Apify or Apollo signals show the business is currently
   *  running paid ads on Google or Meta. NULL = we didn't check. */
  adActive?: boolean | null;
  /** Raw GBP review count. Used both as a direct signal (review
   *  velocity) and as a fallback for revenueBand inference when
   *  Apollo enrichment isn't available. */
  reviewCount?: number | null;
};

/** Inference rules for revenue band when Apollo enrichment isn't
 *  available. Conservative — under-classify rather than over-classify
 *  so we don't pitch LLM to operations that can't sustain the
 *  $2,500/mo retainer. */
export function inferRevenueBand(
  reviewCount: number | null | undefined
): 'low' | 'mid' | 'high' | null {
  if (reviewCount == null) return null;
  if (reviewCount < 50) return 'low';        // < $50K/mo signal
  if (reviewCount < 150) return 'mid';       // $50-150K/mo signal
  return 'high';                              // $150K+/mo signal
}

/**
 * Compute the LLM Fit Score + breakdown.
 *
 * Algorithm:
 *
 *   1. Infer revenueBand if not provided.
 *   2. Apply hard disqualifiers (any one fires → score = 1):
 *        - tradeFit === false
 *        - metroFit === false
 *        - revenueBand === 'low' (and we're confident — i.e. we have
 *          a reviewCount, not just a NULL across the board)
 *   3. Apply positive signals to compute a 2-5 score:
 *        - Base = 3 (possible fit)
 *        - +1 if revenueBand === 'high'
 *        - +1 if adActive === true (existing budget capacity)
 *        - +1 if reviewCount > 150 (revenue + execution velocity)
 *        - Cap at 5
 *        - If revenueBand is NULL (no confidence), subtract 1
 *   4. Floor to 2 if no disqualifiers fired but we couldn't reach 3
 *      via positive signals (the spec's "weak fit" bucket).
 *
 * The function is pure — same inputs always produce the same output.
 * Rule hits are recorded in the breakdown so prep notes can explain
 * the score.
 */
export function computeLlmFitScore(inputs: LlmFitInputs): LlmFitBreakdown {
  const ruleHits: string[] = [];

  const reviewCount = inputs.reviewCount ?? null;
  const revenueBand =
    inputs.revenueBand ?? inferRevenueBand(reviewCount);

  // ─── Hard disqualifiers ──────────────────────────────────────────────
  // Each one floors the score at 1. We keep evaluating so the
  // breakdown lists every reason, not just the first.
  let disqualified = false;

  if (inputs.tradeFit === false) {
    ruleHits.push('disqualifier:trade_outside_scope');
    disqualified = true;
  }
  if (inputs.metroFit === false) {
    ruleHits.push('disqualifier:small_market');
    disqualified = true;
  }
  // Only treat 'low' as a disqualifier when we have a positive signal
  // (a non-null reviewCount that landed in the low band). If
  // revenueBand was passed in directly as 'low', treat that as a
  // confident signal too.
  if (
    revenueBand === 'low' &&
    (inputs.revenueBand === 'low' || reviewCount != null)
  ) {
    ruleHits.push('disqualifier:revenue_below_threshold');
    disqualified = true;
  }

  if (disqualified) {
    return {
      score: 1,
      inputs: {
        revenue_band: revenueBand,
        trade_fit: inputs.tradeFit ?? null,
        metro_fit: inputs.metroFit ?? null,
        ad_active: inputs.adActive ?? null,
        review_count: reviewCount,
      },
      rule_hits: ruleHits,
    };
  }

  // ─── Positive-signal scoring ─────────────────────────────────────────
  let score = 3; // base "possible fit"
  ruleHits.push('base:possible_fit');

  if (revenueBand === 'high') {
    score += 1;
    ruleHits.push('positive:revenue_high');
  }
  if (inputs.adActive === true) {
    score += 1;
    ruleHits.push('positive:ad_active');
  }
  if (reviewCount != null && reviewCount > 150) {
    score += 1;
    ruleHits.push('positive:review_velocity');
  }

  // Confidence penalty when we can't see revenue at all. Two NULL
  // signals in a row (no Apollo, no review count) means we're
  // guessing — drop to "weak fit" so the prep notes flag uncertainty.
  if (revenueBand == null) {
    score -= 1;
    ruleHits.push('penalty:revenue_unknown');
  }

  // Cap and floor.
  score = Math.max(2, Math.min(5, score));

  return {
    score,
    inputs: {
      revenue_band: revenueBand,
      trade_fit: inputs.tradeFit ?? null,
      metro_fit: inputs.metroFit ?? null,
      ad_active: inputs.adActive ?? null,
      review_count: reviewCount,
    },
    rule_hits: ruleHits,
  };
}

/** TRUE if the score warrants the LLM-pitch post-call snippet (4 or
 *  higher per spec). Audit-only snippet for 1-3. */
export function shouldPitchLlm(score: number): boolean {
  return score >= 4;
}

/** Human-readable label for the score, used in the prep notes. */
export function llmFitLabel(score: number): string {
  switch (score) {
    case 5:
      return 'Strong fit';
    case 4:
      return 'Likely fit';
    case 3:
      return 'Possible fit';
    case 2:
      return 'Weak fit';
    case 1:
      return 'Not fit';
    default:
      return 'Unknown';
  }
}
