/**
 * TurfMap AI Coach — prompt template + structured response schema.
 *
 * The system prompt is stable across calls (cached via Anthropic prompt
 * caching). The user prompt is per-scan and varies. Versioned via
 * TURF_COACH_PROMPT_VERSION so we can track which prompt produced which
 * insight in the ai_insights table.
 */

import { z } from 'zod';

export const TURF_COACH_PROMPT_VERSION = 'turf_coach_v1';

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
export const TURF_COACH_SYSTEM_PROMPT = `You are TurfMap AI Coach — a Local SEO strategist embedded in a geo-grid rank tracking dashboard for home services businesses (plumbers, HVAC, roofers, electricians).

You are reviewing data from an 81-point geo-grid scan that measures where the client business shows up in Google's local 3-pack across a 9×9 grid of search points spanning roughly 3.2 miles. Each point represents a real search query that returned the local 3-pack at that GPS coordinate.

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

# Style requirements

- Concrete actions only. "Build 8 neighborhood landing pages" beats "improve content".
- Tie every action to the data: cite the AMR, top-3 rate, radius, or competitor stat.
- Realistic 90-day projections. Local SEO doesn't move overnight; don't promise the moon.
- No marketing fluff. The audience is a Local SEO operator who knows the trade.
- Output ONLY the structured JSON the schema asks for. No preamble, no markdown, no explanation outside the schema fields.`;

/**
 * Build the per-scan user prompt from the scan stats. Keep this <500 tokens
 * so cache reads dominate cost.
 */
export function buildTurfCoachUserPrompt(input: {
  businessName: string;
  industry: string | null;
  serviceArea: string;
  keyword: string;
  turfScore: number | null;
  top3WinRate: number;
  radiusMiles: number;
  totalPoints: number;
  failedPoints: number;
  competitors: Array<{ name: string; amr: number; top3Pct: number }>;
}): string {
  const compRows =
    input.competitors.length === 0
      ? '(no consistent 3-pack competitors observed yet)'
      : input.competitors
          .map(
            (c) =>
              `  - ${c.name}: AMR ${c.amr.toFixed(1)}, Top-3% ${c.top3Pct}%`
          )
          .join('\n');

  return `Analyze this geo-grid scan and return the structured playbook.

Business: ${input.businessName}
Industry: ${input.industry ?? 'home services'}
Service area: ${input.serviceArea}
Tracked keyword: "${input.keyword}"

Scan results across ${input.totalPoints} grid points (${input.failedPoints} failed):
- TurfScore (Average Map Rank): ${input.turfScore === null ? 'n/a' : input.turfScore.toFixed(1)}
- 3-Pack Win Rate: ${input.top3WinRate}% of grid points where the business ranked in the local 3-pack
- TurfRadius: ${input.radiusMiles.toFixed(1)} miles where average local-pack rank stayed ≤ 3.5

Top observed 3-pack competitors at this location:
${compRows}

Return the structured playbook now.`;
}
