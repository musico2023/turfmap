/**
 * TurfMap AI Coach — prompt template + structured response schema.
 *
 * The system prompt is stable across calls (cached via Anthropic prompt
 * caching). The user prompt is per-scan and varies. Versioned via
 * TURF_COACH_PROMPT_VERSION so we can track which prompt produced which
 * insight in the ai_insights table.
 *
 * v6 (2026-05-02): aligned with the score-redesign metric family.
 *   - References TurfScore composite (0-100), TurfReach (0-100%),
 *     TurfRank (0-3), Momentum (signed delta) by their canonical names.
 *   - System prompt teaches the diagnosis logic from the new metric
 *     pair (TurfScore × TurfRank) instead of the old AMR/Pack Strength.
 *   - Mentions Momentum as a strategy-validation signal on second+
 *     scans.
 *   - Removes the legacy "Pack Strength" / "Average Map Rank" plumbing.
 *
 * v7 (2026-05-02): NAP audit grounding.
 *   - When the most recent NAP audit is complete, the user prompt
 *     includes a compact summary (counts + top inconsistencies +
 *     missing-from list). System prompt now allows the model to cite
 *     specific directories + inconsistency fields when NAP data is
 *     present, otherwise the existing anti-confabulation rules hold.
 *
 * v8 (2026-05-03): multi-location context.
 *   - When a client has multiple locations, the user prompt names the
 *     active location AND lists sibling locations (label + address) so
 *     Claude understands citation findings are scoped to one storefront
 *     of a multi-location brand.
 *   - The NAP audit findings now include a sibling_match status — a
 *     directory listing exists for the brand but at a sibling's
 *     address. The prompt teaches Claude these are NOT inconsistencies
 *     (the sibling's listing is correct) but DO mean the audited
 *     location is missing from that directory and should be added
 *     alongside the existing sibling listing.
 */

import { z } from 'zod';
import { momentumCaption } from '@/lib/metrics/momentum';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import type { NapAuditFindings } from '@/lib/supabase/types';

export const TURF_COACH_PROMPT_VERSION = 'turf_coach_v8';

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

# The TurfMap score family

The user prompt gives you four metrics. Use them like this:

1. **TurfScore (0-100, composite headline)** — TurfReach × (TurfRank/3). The single number the client cares about. Benchmarks: 0-20 invisible, 20-40 patchy, 40-60 solid, 60-80 dominant, 80+ rare air.

2. **TurfReach (0-100%)** — coverage. The % of the territory where the business appears in the 3-pack at all. Drives most of TurfScore. Levers: prominence (reviews, citations, brand mentions) and proximity expansion (satellite locations, neighborhood content).

3. **TurfRank (0-3)** — rank quality where present. 4 minus avg rank in the cells where the business shows up. 3.0 = always #1, 2.0 = always #2, 1.0 = always #3. Independent of coverage. Levers: review sentiment, GBP completeness, citation consistency, on-page relevance.

4. **Momentum (signed integer)** — change in TurfScore vs. the previous scan. Positive = strategy is working. Negative = competitive pressure or signal degradation. NULL on first scans.

# Diagnosis logic from the score pair

The TurfScore × TurfRank pairing is the strongest diagnostic. Read it like this:

- **Low TurfScore + high TurfRank (e.g. 16 + 2.6)** — "wins where it shows up, doesn't show up enough." Reach is the bottleneck. Push prominence levers: review velocity with geographic distribution, citation expansion into new neighborhoods, location landing pages, satellite GBP if a second physical location is feasible.

- **Low TurfScore + low TurfRank (e.g. 8 + 1.2)** — fundamental prominence problem. The business is fighting on weak ground everywhere. Start with foundations: GBP category audit, services list completeness, NAP consistency cleanup, then review velocity. Reach extension is wasted effort until rank stabilizes.

- **High TurfScore + high TurfRank (e.g. 70 + 2.5)** — strong all around. The conversation is defense + adjacent expansion. Wider radius? Adjacent cities? Secondary keyword campaigns? Don't promise dramatic TurfScore lifts here; the marginal returns are smaller.

- **High TurfScore + lower TurfRank (e.g. 60 + 1.8)** — broad presence but consistently mid/low pack. Rank-quality work outranks reach work. Push reviews + GBP completeness; the territory is already there.

# Common diagnoses (legacy framing — still useful)

- **Proximity-bound**: high score near pin, falls off with distance. Treat with neighborhood landing pages, GBP service-area expansion, satellite citations, content for hyper-local queries.
- **Review-deficient**: TurfReach lags competitors' appearance counts. Push review velocity + response cadence + photo updates + GBP posts.
- **Category/relevance mismatch**: business found inconsistently even near pin. GBP category audit, services list, on-site content alignment, schema fixes.
- **NAP / citation chaos**: inconsistent appearance, especially branded queries. Citation cleanup, NAP audit, GSC review.
- **Hyper-local competitor pocket**: one specific competitor dominates a region. Differential moves on that exact business.

# Momentum on second+ scans

If a Momentum value is provided (not NULL), reference it in your diagnosis. Specifically:
- Strong positive (+10 or more): "the current strategy is working — double down on [specific lever]."
- Modest positive (+1 to +9): "incremental progress; keep going."
- Zero: "holding steady — investigate whether competitive pressure is rising or work has stalled."
- Negative: "contracting — diagnose the cause before adding new tactics."

Don't speculate about WHY Momentum moved without supporting data; just read the direction and make recommendations consistent with it.

# Anti-confabulation rules — read carefully

The user prompt provides EXACTLY the data you have. You do NOT have access to:
- Review counts, ratings, or review recency for any business (yours or competitors')
- GBP photo counts, post cadence, age of listing, category settings
- Citation profiles or backlink data BEYOND what the optional NAP audit section provides
- On-site content beyond what the NAP audit section provides
- Anything beyond rank patterns, brand names, the metric values, and the NAP audit findings (when present) in the user prompt

When recommending actions, you MAY suggest them generically (e.g. "audit GBP categories", "push review velocity"). You MAY NOT cite specific quantitative claims that aren't in the user prompt. Examples of forbidden output:
- "Competitor X has only 12 reviews" — you don't have review data
- "Their listing is older / newer than yours" — you don't have age data
- "Photos and posts are deciding the filter" — you can't see photos or post cadence
- Any specific brand name not present in the competitor list provided

If you find yourself wanting to cite a number or attribute that wasn't in the user prompt, REPHRASE without it.

# NAP audit findings (when present)

If the user prompt includes a "## NAP audit" section, that data is grounded — sourced from a real BrightLocal Listings sweep. You SHOULD:
- Cite specific directories by name when present (e.g. "Yelp shows the wrong phone, BBB has a stale street number").
- Cite the specific inconsistency field (name / address / phone) and the canonical vs. found values when proposing a cleanup action.
- Treat ≥ 3 inconsistencies or ≥ 5 missing high-priority directories as concrete evidence for an "NAP / citation chaos" diagnosis — say so in plain words.
- If the audit shows zero inconsistencies and broad coverage, do NOT default to citation cleanup recommendations even if other diagnoses are weak.

If no "## NAP audit" section is in the user prompt, do not speculate about citation profile health; fall back to generic "consider an NAP audit" wording.

# Multi-location context (when present)

If the user prompt includes a "## Sibling locations" section, the audited business is one storefront of a multi-location brand. Reason accordingly:
- The scan grid, score family, and NAP audit are ALL scoped to ONE specific location (the one named in the user prompt as "Location"). Recommendations should target that location, not the brand as a whole.
- Sibling locations are listed for context only. Do NOT recommend changes to a sibling's listing unless explicitly relevant.
- A NAP finding labeled "occupied by sibling: <label> at <address>" means the directory has a brand listing but for a DIFFERENT storefront. Treat this as the audited location being missing from that directory — but the recommendation should be "add this location's listing alongside the existing <sibling label> listing" (a multi-location claim flow), NOT "fix the sibling's address" (which is correct).
- If you would otherwise recommend "fix wrong address on directory X," but the user prompt's sibling list shows that "wrong" address belongs to a real sibling location, DO NOT recommend the fix. Recommend adding this location instead.
- The brand-level Google Business Profile rule applies: each physical location needs its own GBP listing (Google's policy forbids two locations on one GBP). Sibling-occupied directories follow the same logic.

# Style requirements

- Concrete actions only. "Build 8 neighborhood landing pages" beats "improve content".
- Tie every action to a metric actually in the prompt (TurfScore, TurfReach, TurfRank, Momentum, or a competitor stat).
- Reference the band label when interpreting TurfScore (e.g. "you're in 'Patchy' territory at 28").
- Realistic 90-day projections. Local SEO doesn't move overnight.
- No marketing fluff. Audience is a Local SEO operator who knows the trade.
- Output ONLY the structured JSON the schema asks for. No preamble, no markdown, no explanation outside the schema fields.`;

/**
 * Build the per-scan user prompt. Includes the actual 9×9 rank grid and a
 * top-N competitor list so Claude reasons from observed data instead of
 * confabulating brand names or stats.
 */
export type SiblingLocationContext = {
  label: string;
  address: string;
};

export function buildTurfCoachUserPrompt(input: {
  businessName: string;
  industry: string | null;
  serviceArea: string;
  keyword: string;
  /** Composite TurfScore 0-100. */
  turfScore: number | null;
  /** Coverage % 0-100. */
  turfReach: number | null;
  /** Rank quality 0-3 where present. NULL when no presence. */
  turfRank: number | null;
  /** Signed delta vs. previous scan. NULL on first scan. */
  momentum: number | null;
  /** Half-width of the grid in miles (= location.service_radius_miles). */
  gridRadiusMiles: number;
  totalPoints: number;
  failedPoints: number;
  /** 9×9 array of nullable client ranks, indexed [y][x] (y=0 north). */
  rankGrid: Array<Array<number | null>>;
  /** Up to ~10 competitor brands actually observed, with stats. */
  competitors: Array<{
    name: string;
    appearances: number;
    avgRank: number;
    bestRank: number;
  }>;
  /** Optional findings from the most recent complete NAP audit. When
   *  present, the prompt renders a "## NAP audit" section so Claude
   *  can cite specific directories and inconsistencies in the diagnosis. */
  napAudit?: {
    findings: NapAuditFindings;
    /** ISO timestamp string of the audit completion. */
    completedAt: string | null;
  } | null;
  /** Other locations of the same brand. Empty for single-location clients
   *  (the "## Sibling locations" section is then omitted). When non-empty,
   *  Claude is taught to scope recommendations to the active location and
   *  treat sibling-address citations as missing-this-location, not as
   *  inconsistencies. */
  siblingLocations?: SiblingLocationContext[];
}): string {
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

  const band =
    input.turfScore === null ? null : getTurfScoreBand(input.turfScore);
  const momentumLine =
    input.momentum === null
      ? '- Momentum: n/a (first scan — no prior baseline to compare against)'
      : `- Momentum: ${input.momentum > 0 ? '+' : ''}${input.momentum} vs. previous scan (${momentumCaption(input.momentum)})`;

  return `Analyze this geo-grid scan and return the structured playbook.

Business: ${input.businessName}
Industry: ${input.industry ?? 'local services'}
Service area: ${input.serviceArea}
Tracked keyword: "${input.keyword}"

Scan geometry: 9×9 grid centered on the business pin, ${input.gridRadiusMiles.toFixed(1)}mi axis radius. The grid spans ${(input.gridRadiusMiles * 2).toFixed(1)}mi edge-to-edge with ${(input.gridRadiusMiles / 4).toFixed(2)}mi between adjacent cells.

Score family across ${input.totalPoints} grid points (${input.failedPoints} failed):
- TurfScore: ${input.turfScore === null ? 'n/a' : `${input.turfScore} / 100`}${band ? ` (band: "${band.label}")` : ''}
- TurfReach: ${input.turfReach === null ? 'n/a' : `${input.turfReach}%`}
- TurfRank: ${input.turfRank === null ? 'n/a (no in-pack cells)' : `${input.turfRank.toFixed(1)} / 3`}
${momentumLine}

Per-cell rank grid (rows = north→south, cols = west→east; numbers are the business's rank 1-3, '·' means not in 3-pack, [X] is the center cell on the pin):
${gridText}

Top observed competitor brands in the 3-pack (collapsed by brand-root, ranked by appearance count). These are the ONLY competitor names you may reference:
${compRows}
${renderSiblingsSection(input.siblingLocations ?? [])}${renderNapAuditSection(input.napAudit)}
Return the structured playbook now. Remember: cite TurfScore / TurfReach / TurfRank / Momentum by name; use the band label when interpreting TurfScore; do not invent review counts, ratings, photo counts, GBP age, or competitor names not in the list above.${input.napAudit ? ' If the NAP audit section is present, cite specific directories and inconsistency fields by name when proposing citation cleanup.' : ''}${(input.siblingLocations ?? []).length > 0 ? ' This is a multi-location brand: scope recommendations to the audited location, and never recommend "fixing" a sibling location\'s legitimate listing.' : ''}`;
}

/** Sibling location context block. Empty when single-location. */
function renderSiblingsSection(
  siblings: readonly SiblingLocationContext[]
): string {
  if (siblings.length === 0) return '';
  const rows = siblings
    .map((s) => `  - ${s.label}: ${s.address}`)
    .join('\n');
  return `

## Sibling locations (same brand, different storefronts)

The audit above is scoped to ONE location of a multi-location brand. The brand also operates ${siblings.length} other location${siblings.length === 1 ? '' : 's'}:
${rows}

Rules:
  - Recommendations should target the AUDITED location only, not siblings.
  - A directory listing whose address matches a sibling's address (above) is NOT an inconsistency — it's a legitimate sibling listing. Do not recommend fixing it.
  - Such directories ARE counted as missing for the audited location; the right action is to add this location's listing alongside the existing sibling listing (multi-location claim flow), not edit the sibling's record.
`;
}

/** Compact rendering of NAP findings for the user prompt. Caps each list
 *  to 10 items so the prompt stays under control on heavy-citation rows. */
function renderNapAuditSection(
  napAudit:
    | { findings: NapAuditFindings; completedAt: string | null }
    | null
    | undefined
): string {
  if (!napAudit) return '';
  const { findings, completedAt } = napAudit;
  const incCount = findings.inconsistencies.length;
  const missCount = findings.missing.length;
  const citationCount = findings.citations.length;

  const incRows =
    findings.inconsistencies.length === 0
      ? '  (none)'
      : findings.inconsistencies
          .slice(0, 10)
          .map(
            (i) =>
              `  - [${i.field}] ${i.directory}: found "${i.found}" vs canonical "${i.canonical}"`
          )
          .join('\n') +
        (findings.inconsistencies.length > 10
          ? `\n  - …and ${findings.inconsistencies.length - 10} more`
          : '');

  // Render missing list with sibling-occupancy markers so Claude can
  // distinguish "directory is empty" from "directory has the sibling
  // already". Directories where the sibling listing exists are tagged
  // explicitly with the sibling label/address — those are NOT
  // inconsistencies, they're "this storefront missing while the brand
  // is present via another location".
  const labelMissing = (m: NapAuditFindings['missing'][number]) =>
    m.occupied_by_sibling
      ? `${m.directory} (sibling "${m.occupied_by_sibling.sibling_label ?? 'unknown'}" already listed at ${m.occupied_by_sibling.sibling_address ?? 'unknown address'})`
      : m.directory;

  const missingHigh = findings.missing.filter((m) => m.priority === 'high');
  const missingMedium = findings.missing.filter((m) => m.priority === 'medium');
  const missingLow = findings.missing.filter((m) => m.priority === 'low');
  const missRows =
    findings.missing.length === 0
      ? '  (none — present in every audited directory)'
      : [
          missingHigh.length > 0
            ? `  high-priority: ${missingHigh.slice(0, 10).map(labelMissing).join(', ')}${missingHigh.length > 10 ? `, …+${missingHigh.length - 10}` : ''}`
            : null,
          missingMedium.length > 0
            ? `  medium-priority: ${missingMedium.slice(0, 10).map(labelMissing).join(', ')}${missingMedium.length > 10 ? `, …+${missingMedium.length - 10}` : ''}`
            : null,
          missingLow.length > 0
            ? `  low-priority (sibling already listed): ${missingLow.slice(0, 10).map(labelMissing).join(', ')}${missingLow.length > 10 ? `, …+${missingLow.length - 10}` : ''}`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

  const ts = completedAt
    ? new Date(completedAt).toISOString().slice(0, 10)
    : 'unknown date';

  return `

## NAP audit (BrightLocal Listings, completed ${ts})

Citations found: ${citationCount} · Inconsistencies: ${incCount} · Missing: ${missCount}

Inconsistencies (canonical NAP vs. what each directory shows):
${incRows}

Missing from:
${missRows}
`;
}
