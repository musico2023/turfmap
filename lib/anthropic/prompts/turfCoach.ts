/**
 * TurfMap AI Coach — prompt template + structured response schema.
 *
 * The system prompt is stable across calls (cached via Anthropic prompt
 * caching). The user prompt is per-scan and varies. Versioned via
 * TURF_COACH_PROMPT_VERSION so we can track which prompt produced which
 * insight in the ai_insights table.
 */

import { z } from 'zod';

export const TURF_COACH_PROMPT_VERSION = 'turf_coach_v3';

export const TurfCoachAction = z.object({
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  action: z.string().describe('Specific action in 6-10 words'),
  why: z
    .string()
    .describe('One sentence rationale tied to the data — no fluff'),
});

export const TurfCoachInsight = z.object({
  diagnosis: z
    .string()
    .describe(
      'One sentence identifying the primary visibility problem (proximity, prominence, or relevance)'
    ),
  actions: z
    .array(TurfCoachAction)
    .min(3)
    .max(3)
    .describe('Exactly three prioritized actions'),
  projectedImpact: z
    .string()
    .describe('One sentence projecting realistic 90-day impact'),
});

export type TurfCoachInsightT = z.infer<typeof TurfCoachInsight>;
export type TurfCoachActionT = z.infer<typeof TurfCoachAction>;

/**
 * Long-lived system prompt. Cache this — stable across all calls. Designed
 * to clear the 2048-token threshold for Sonnet 4.6 caching with room to spare.
 */
export const TURF_COACH_SYSTEM_PROMPT = `You are TurfMap AI Coach — a Local SEO strategist embedded in a geo-grid rank tracking dashboard for local-service businesses (plumbers, HVAC, roofers, electricians, healthcare practices, etc.).

You are reviewing data from an 81-point geo-grid scan that measures where the client business shows up in Google's local 3-pack across a 9×9 grid of search points. The grid's spatial extent depends on the client's service area and is provided in the user prompt — never assume a fixed mile range. Each grid point represents a real search query that returned the local 3-pack at that GPS coordinate.

Your job: turn the scan data into a strategic playbook the agency operator can execute this month.

# How Local SEO works at a grid level

Three forces drive local 3-pack visibility:

1. **Proximity** — distance from the searcher to the business pin. Cells near the pin will rank higher even with weak signals. Cells far from the pin demand stronger prominence + relevance to compensate.

2. **Prominence** — how Google evaluates the business's authority: review count, review velocity, review sentiment, citation count + consistency, backlink profile, brand mentions, age of the GBP listing. Prominence helps cells far from the pin.

3. **Relevance** — how clearly the business matches the search intent: GBP categories, GBP services, the Q&A section, posts, business name keyword presence, on-site content, neighborhood landing pages, schema markup. Relevance helps cells where the searcher's keyword is competitive or where the searcher's location implies a different "service area".

A heatmap that's lime (top 3) at the center and red (out-of-pack) at the edges is **proximity-bound** — strong locally but no prominence/relevance to fan out. A heatmap that's red at the center and orange at the edges is **prominence-broken** — Google is filtering out the listing entirely. A heatmap with sporadic lime cells in distant directions is **competitor-pocket-bound** — Google is favoring localized competitors in those neighborhoods.

# Common diagnoses

- **Proximity-bound (most common)**: high score near pin, falls off with distance. Treat with neighborhood landing pages, GBP service-area expansion, satellite citations, content for hyper-local queries.
- **Review-deficient relative to competitors**: top-3 win rate < competitor's top-3 rate, AMR worse than top competitor's AMR. Treat with review-velocity push, response cadence, photo updates, GBP posts.
- **Category/relevance mismatch**: business found inconsistently even near pin. Treat with GBP category audit, services list, on-site content alignment, schema fixes.
- **NAP / citation chaos**: inconsistent appearance, especially for branded queries. Treat with citation cleanup, NAP audit across top 50 directories, Google Search Console review.
- **Hyper-local competitor**: one specific competitor dominates the 3-pack at high frequency. Treat with competitive analysis on that exact business, then differential moves (faster reviews, more services, niche keywords).

# Anti-confabulation rules — read carefully

The user prompt provides EXACTLY the data you have. You do NOT have access to:
- Review counts, ratings, or review recency for any business (yours or competitors')
- GBP photo counts, post cadence, age of listing, category settings
- Citation profiles, backlink data, on-site content
- Anything beyond rank patterns, brand names, and aggregate counts already in the user prompt

When recommending actions, you MAY suggest them generically (e.g. "audit GBP categories", "push review velocity"). You MAY NOT cite specific quantitative claims that aren't in the user prompt. Examples of forbidden output:
- "Competitor X has only 12 reviews" — you don't have review data
- "Their listing is older / newer than yours" — you don't have age data
- "Photos and posts are deciding the filter" — you can't see photos or post cadence
- Any specific brand name not present in the competitor list provided

If you find yourself wanting to cite a number or attribute that wasn't in the user prompt, REPHRASE without it. The diagnosis can still identify the pattern (proximity-bound, review-deficient inferred from rank gaps, etc.) without inventing data.

# Style requirements

- Concrete actions only. "Build 8 neighborhood landing pages" beats "improve content".
- Tie every action to the data: cite the AMR, top-3 rate, radius, or competitor stat actually in the prompt.
- Realistic 90-day projections. Local SEO doesn't move overnight; don't promise the moon.
- No marketing fluff. The audience is a Local SEO operator who knows the trade.
- Output ONLY the structured JSON the schema asks for. No preamble, no markdown, no explanation outside the schema fields.`;

/**
 * Build the per-scan user prompt. Includes the actual 9×9 rank grid and a
 * top-N competitor list so Claude reasons from observed data instead of
 * confabulating brand names or stats.
 */
export function buildTurfCoachUserPrompt(input: {
  businessName: string;
  industry: string | null;
  serviceArea: string;
  keyword: string;
  turfScore: number | null;
  top3WinRate: number;
  /** Result of the (newly redefined) turfRadius — max ring distance with
   *  any in-pack cell, multiplied by miles-per-ring. */
  radiusMiles: number;
  /** Half-width of the grid in miles (= client.service_radius_miles).
   *  Lets the AI reason about the actual scan footprint instead of
   *  assuming the default 1.6mi. */
  gridRadiusMiles: number;
  totalPoints: number;
  failedPoints: number;
  /** 9×9 array of nullable client ranks, indexed [y][x] (y=0 north). */
  rankGrid: Array<Array<number | null>>;
  /** Up to ~10 competitor brands actually observed, with stats. The AI is
   *  instructed to use ONLY this list when naming competitors. */
  competitors: Array<{
    name: string;
    appearances: number;
    avgRank: number;
    bestRank: number;
  }>;
}): string {
  // Render 9×9 as a fixed-width grid Claude can reason about visually.
  // 'X' = in pack with rank, '·' = not in pack. Center cell marked.
  const center = Math.floor(input.rankGrid.length / 2);
  const gridText = input.rankGrid
    .map((row, y) =>
      row
        .map((rank, x) => {
          const cell = rank === null ? '·' : String(rank);
          const isCenter = x === center && y === center;
          return isCenter ? `[${cell}]` : ` ${cell} `;
        })
        .join('')
    )
    .join('\n');

  const compRows =
    input.competitors.length === 0
      ? '(no observed 3-pack competitors)'
      : input.competitors
          .map(
            (c) =>
              `  - ${c.name}: ${c.appearances} cells, avg rank ${c.avgRank.toFixed(1)}, best rank ${c.bestRank}`
          )
          .join('\n');

  return `Analyze this geo-grid scan and return the structured playbook.

Business: ${input.businessName}
Industry: ${input.industry ?? 'local services'}
Service area: ${input.serviceArea}
Tracked keyword: "${input.keyword}"

Scan geometry: 9×9 grid centered on the business pin, ${input.gridRadiusMiles.toFixed(1)}mi axis radius. The grid spans ${(input.gridRadiusMiles * 2).toFixed(1)}mi edge-to-edge with ${(input.gridRadiusMiles / 4).toFixed(2)}mi between adjacent cells.

Aggregate metrics across ${input.totalPoints} grid points (${input.failedPoints} failed):
- TurfScore (Average Map Rank — lower is better; cells not in 3-pack count as 20): ${input.turfScore === null ? 'n/a' : input.turfScore.toFixed(1)}
- 3-Pack Win Rate: ${input.top3WinRate}% of cells where the business ranked in the local 3-pack
- TurfRadius (max-reach): ${input.radiusMiles.toFixed(1)}mi — furthest grid distance where the business reached the 3-pack at all

Per-cell rank grid (rows = north→south, cols = west→east; numbers are the business's rank 1-3, '·' means not in 3-pack, [X] is the center cell on the pin):
${gridText}

Top observed competitor brands in the 3-pack (collapsed by brand-root, ranked by appearance count). These are the ONLY competitor names you may reference:
${compRows}

Return the structured playbook now. Remember: do not cite review counts, ratings, photo counts, GBP age, or any specific quantitative attribute not listed above.`;
}
