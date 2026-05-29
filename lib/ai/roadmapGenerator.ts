/**
 * AI Roadmap Generator — turns a buyer's audit data into a structured
 * 12-week 90-Day Roadmap.
 *
 * Method (decision (c) from the planning round):
 *
 *   - Claude picks WHICH actions apply to this specific buyer + the
 *     order they should be executed in
 *   - The PROJECTED LIFT NUMBERS come from a deterministic heuristic
 *     table (see HEURISTIC_LIFTS below), not from Claude
 *
 * This split is load-bearing for the TurfScore Lift Promise. The
 * promise says "implement within 14 days; if your TurfScore doesn't
 * lift by +10 points within 90 days, we refund your $499" — the model
 * would happily project 15 points off any combination of actions if
 * asked, and we'd be on the hook for that number even when the
 * real-world lift is smaller. By having the AI select + sequence +
 * describe but not estimate, we keep numerical defensibility while
 * still getting per-buyer adaptive content.
 *
 * The Roadmap structure (3 phases × 4 weeks) and category constraints
 * are baked into the system prompt. Output is a structured JSON
 * matching `RoadmapOutput` below; the route handler maps each entry
 * into a `roadmap_actions` row + sets the `lift_promise_target_score`
 * on the parent `visibility_audits` row from the cumulative projection.
 *
 * Cost target: <$0.20 per call. Sonnet 4.6 with prompt caching on the
 * stable system prompt + adaptive thinking (max 4k thinking tokens —
 * the structure is well-bounded so we don't need 32k like the AI
 * Coach uses for diagnosis reasoning).
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { COACH_MODEL, getAnthropic } from '@/lib/anthropic/client';
import {
  ALLOWED_ACTION_CATEGORIES,
  ACTION_CATEGORIES,
  isLlmCovered,
  pillarForAction,
  type Pillar,
} from '@/lib/audit/actionCategories';
import type { ActionCategory } from '@/lib/supabase/types';

export const ROADMAP_GENERATOR_VERSION = 'roadmap_v1';

// ─── Heuristic lift table ──────────────────────────────────────────────
//
// Source-of-truth for "what's this action worth in TurfScore points?"
// Calibration source: aggregated lift observations from ~80 paid TurfScan
// re-scans we ran during the post-launch period (commit history through
// Q2 '26). Numbers are intentionally conservative — we'd rather under-
// promise + over-deliver on the 10-point Lift Promise.
//
// The AI Roadmap Generator does NOT see these numbers (we don't want
// the model to game its action selection toward higher-numbered
// categories). The mapping happens after the model returns its
// structured output, at row-insert time.

type LiftHeuristic = {
  /** Per-action base lift in TurfScore points. */
  base: number;
  /** Diminishing-returns shaping when the buyer has multiple
   *  actions in the same category. The N-th action in a category
   *  gets `base × diminish^(N-1)`. Floor at 1 point. */
  diminish: number;
};

export const HEURISTIC_LIFTS: Record<ActionCategory, LiftHeuristic> = {
  review_velocity: { base: 6, diminish: 0.5 },
  directory_claiming: { base: 4, diminish: 0.6 },
  gbp_optimization: { base: 5, diminish: 0.4 },
  gbp_photos: { base: 3, diminish: 0.6 },
  schema_integration: { base: 4, diminish: 0.5 },
  nap_consistency: { base: 3, diminish: 0.7 },
  other: { base: 2, diminish: 0.5 },
};

/** Apply the diminishing-returns curve to a category's N-th action.
 *  N is 1-indexed: the first action in a category gets full base
 *  lift; the second gets `base × diminish`; the third gets
 *  `base × diminish²`; etc. Always at least 1 point so the AI's
 *  weakest selections still register on the Lift Promise math. */
export function liftForAction(
  category: ActionCategory,
  positionInCategory: number
): number {
  const h = HEURISTIC_LIFTS[category];
  const raw = h.base * Math.pow(h.diminish, Math.max(0, positionInCategory - 1));
  return Math.max(1, Math.round(raw));
}

// ─── Structured output schema ─────────────────────────────────────────

/** The model picks a category from this fixed list. We constrain via
 *  Zod enum so a bad response (typo, hallucinated category) is caught
 *  by the parser before it lands in a roadmap_actions row. */
const CategoryEnum = z.enum(
  ALLOWED_ACTION_CATEGORIES as unknown as [ActionCategory, ...ActionCategory[]]
);

const RoadmapAction = z.object({
  week: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe('Week number 1-12'),
  action: z
    .string()
    .min(8)
    .describe(
      "Specific, buyer-customized action. 8-25 words is the target — referencing real findings (NAP gaps, missing categories, competitor differentials) often pushes longer. PDF/dashboard truncate visually if needed; we don't reject for length."
    ),
  category: CategoryEnum.describe(
    'One of the allowed action categories. Pick the closest fit.'
  ),
  /** Which Local Lead Machine pillar this action lives under. For
   *  fixed-pillar categories (review_velocity = systems, gbp_* +
   *  nap_* + directory_* + schema = visibility) the render site
   *  overrides whatever the AI emits with the canonical mapping —
   *  so the field really only matters when category is 'other'.
   *  We still ask the AI to populate it always for consistency
   *  and future-proofing (e.g., if we add `paid_ads` as a category
   *  later, the pillar field stays meaningful). */
  pillar: z
    .enum(['visibility', 'demand', 'systems'])
    .describe(
      "LLM pillar this action lives under. 'visibility' = organic local pack work (GBP, NAP, directories, schema, photos, local SEO content). 'demand' = paid traffic + conversion (Google/Meta Ads, landing funnels, creative). 'systems' = lead capture + workflow (review automation, CRM, email follow-up, attribution). For category='review_velocity' use systems. For category='gbp_*' / 'nap_*' / 'directory_*' / 'schema_*' use visibility. For category='other' pick the pillar that genuinely fits — landing pages = demand, CRM/follow-up = systems, long-tail content = visibility."
    ),
  difficulty: z
    .enum(['DIY-easy', 'DIY-medium', 'DIY-hard'])
    .describe(
      "How hard is this for a small-business operator to execute themselves? 'easy' = under 30 min, 'medium' = under 4 hrs, 'hard' = full day or specialized skill."
    ),
  priority: z
    .enum(['HIGH', 'MEDIUM', 'LOW'])
    .describe(
      "Urgency relative to the buyer's biggest visibility gaps. HIGH = directly addresses their lowest-scoring dimension. MEDIUM = supportive. LOW = nice-to-have."
    ),
});

const RoadmapOutput = z.object({
  /** One-paragraph diagnosis of the buyer's primary visibility gap.
   *  Used on PDF page 1 + as the anchor for the strategist call's
   *  opening framing. We don't cap length tightly — Claude
   *  occasionally writes 1-2 sentences instead of strictly one,
   *  and rejecting the output for a 5-character overrun would be
   *  silly. The prompt asks for one sentence; if the model needs
   *  a second to be specific, we accept it. */
  diagnosis: z
    .string()
    .min(20)
    .describe(
      "1-2 sentences diagnosing the primary visibility gap (proximity / prominence / relevance + the specific lever). Aim for one sentence; two is acceptable when needed for specificity."
    ),
  /** 8-12 actions across the 12 weeks; we accept up to 15 to give
   *  the model room when a complex audit warrants more work. Phase
   *  boundaries (1-4 / 5-8 / 9-12) are enforced through week_number
   *  ordering, not explicit fields — phase 1 actions land in weeks
   *  1-4, etc. */
  actions: z
    .array(RoadmapAction)
    .min(8)
    .max(15)
    .describe(
      '8-12 prioritized actions across the 12 weeks (up to 15 if needed). Phase 1 (weeks 1-4) = Foundation: NAP/directory/critical fixes. Phase 2 (weeks 5-8) = Authority: review velocity, GBP optimization, secondary directories. Phase 3 (weeks 9-12) = Optimization: long-tail directories, schema, content. Distribute roughly evenly.'
    ),
});

export type RoadmapOutputT = z.infer<typeof RoadmapOutput>;
export type RoadmapActionT = z.infer<typeof RoadmapAction>;

// ─── Prompt construction ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the TurfMap AI Roadmap Generator. Your job is to take a small-business operator's local-SEO audit data and produce a 90-day visibility roadmap broken into 12 weekly action items.

You work for Fourdots Digital. The roadmap is delivered as part of a $499 Visibility Audit. The strategist (Anthony) presents your roadmap to the buyer on a 30-minute call, then sends them the PDF. The roadmap is also the basis of a TurfScore Lift Promise: the buyer implements the recommendations within 14 days, and if their TurfScore doesn't lift by at least 10 points within 90 days, they get a full $499 refund. Frame the actions for execution inside that 14-day implementation window where possible — Foundation-phase actions (Weeks 1-4) should be the ones that can realistically start inside 14 days.

YOUR JOB:
1. Diagnose the buyer's primary visibility gap (proximity / prominence / relevance) in one sentence.
2. Select 8-12 specific actions across 12 weeks.
3. Tag each action with a category, an LLM pillar, a difficulty rating, and a priority.
4. Order actions so weeks 1-4 (Foundation) handle the most urgent fixes, weeks 5-8 (Authority) build review/GBP momentum, weeks 9-12 (Optimization) are long-tail.

CONSTRAINTS:
- Be specific. "Claim Apple Maps Connect listing" beats "Improve directory presence." Reference the buyer's actual findings (specific missing directories, NAP inconsistencies, competitor differentials) when present in the input.
- DO NOT estimate the score lift per action. The system computes that downstream from a calibrated heuristic — you focus on selection + sequencing + clarity.
- Use the action categories below. Pick the closest fit; use 'other' sparingly (only for actions that don't map to a named visibility-pillar category — most often that's a demand-pillar landing page or a systems-pillar workflow).
- THIS ROADMAP IS A VISIBILITY-PILLAR DELIVERABLE. Most actions (8-10 of 12) should be category-driven Visibility work the buyer can execute solo. 1-2 Demand or Systems actions are acceptable and useful — they're the bridge into the strategist call's Local Lead Machine discussion.
- Do not invent data. If the buyer's NAP audit didn't run, don't reference specific directory names — use generic "claim missing directories on the top-trade-relevant sites" framing.

PILLAR ASSIGNMENT (always set the pillar field):
- VISIBILITY pillar: GBP optimization, GBP photos, NAP consistency, directory claiming, schema integration, long-tail local-SEO content. → category: gbp_optimization | gbp_photos | nap_consistency | directory_claiming | schema_integration (and pillar: 'visibility' for an 'other' action that's pure local-SEO content)
- SYSTEMS pillar: review velocity automation (post-job SMS/email systems), CRM, email follow-up sequences, attribution. → category: review_velocity (always pillar: 'systems'), or 'other' with pillar: 'systems' for non-review systems work
- DEMAND pillar: paid ads, Google Ads / Meta Ads strategy, landing pages, conversion funnels, creative refresh. → category: 'other' with pillar: 'demand'

ACTION CATEGORIES:

${ACTION_CATEGORIES.map(
  (c) => `- ${c.id}: ${c.promptDescription}`
).join('\n')}

DIFFICULTY:
- DIY-easy: under 30 minutes, no specialized skill (e.g., update GBP hours, add 5 photos)
- DIY-medium: under 4 hours, may require some learning (e.g., write GBP description, set up review request system)
- DIY-hard: full day or specialized skill (e.g., implement schema markup, build review automation)

PRIORITY:
- HIGH: directly addresses the buyer's lowest-scoring dimension or fixes a critical gap (missing top-3 directory, NAP wrong on Google itself, etc.)
- MEDIUM: supportive — moves a secondary metric or compounds with HIGH actions
- LOW: nice-to-have — small marginal lift, mostly belt-and-suspenders polish

Output the roadmap as structured JSON matching the schema.`;

/** Per-keyword scan stats — used in the secondaryKeywords[] input
 *  to feed the AI prompt comparative context for Strategy Session
 *  ($1,497) buyers who paid for the 3-keyword analysis. */
export type RoadmapKeywordStats = {
  keyword: string;
  /** TurfScore for this keyword's scan (0-100). */
  turfScore: number;
  /** TurfReach % (cells where buyer appears in pack, 0-100). */
  turfReach: number | null;
  /** TurfRank (avg pack position when present, 0-3). */
  turfRank: number | null;
};

/** Inputs to the roadmap generator. All optional fields are nullable
 *  so the caller can pass partial data — the prompt teaches Claude
 *  to handle missing inputs gracefully. */
export type RoadmapInput = {
  /** Required. Buyer's business name. */
  businessName: string;
  /** Required. Buyer's trade/industry (e.g., "HVAC", "Roofing", "Renovation"). */
  trade: string;
  /** Required. Primary keyword the audit was run against. */
  keyword: string;
  /** Required. City + region for context ("Austin, TX"). */
  market: string;
  /** Required. Current TurfScore (0-100). */
  currentTurfScore: number;
  /** TurfReach % (cells where buyer appears in pack, 0-100). */
  turfReach: number | null;
  /** TurfRank (avg pack position when present, 0-3). */
  turfRank: number | null;
  /** NAP audit summary, if available. Free-form bullet list of
   *  findings — the prompt parses it as context. NULL when the
   *  NAP audit didn't run or isn't complete yet. */
  napFindingsSummary: string | null;
  /** Top 3 competitors' summary — name + TurfScore + brief
   *  differential ("Air-Pro Heating: 72 (380 reviews vs. your 124)").
   *  NULL when competitor scoring isn't yet computed. */
  competitorSummary: string | null;
  /** Cell-pattern summary — describes where the buyer is dark vs.
   *  visible across the 81-point grid. ("Dark cells concentrated
   *  in the SE quadrant; visible only within 1.2 mi of HQ"). */
  cellPatternSummary: string | null;
  /** Strategy-tier comparative keywords (the 2nd + 3rd keyword
   *  scans, alongside the primary). When present, the prompt is
   *  instructed to weave the cross-keyword comparison into the
   *  diagnosis blurb so the strategist call has the comparative
   *  framing baked into the Roadmap. NULL / empty for scan + audit
   *  tiers (single-keyword). */
  secondaryKeywords?: RoadmapKeywordStats[] | null;
};

function buildUserPrompt(input: RoadmapInput): string {
  const parts: string[] = [
    `BUYER: ${input.businessName} — ${input.trade} in ${input.market}`,
    `PRIMARY KEYWORD: "${input.keyword}"`,
    '',
    'AUDIT DATA:',
    `- Current TurfScore: ${input.currentTurfScore}/100`,
  ];

  if (input.turfReach != null) {
    parts.push(`- TurfReach: ${input.turfReach.toFixed(1)}% (cells where buyer appears in pack)`);
  }
  if (input.turfRank != null) {
    parts.push(`- TurfRank: ${input.turfRank.toFixed(2)}/3 (avg pack position when present)`);
  }
  if (input.cellPatternSummary) {
    parts.push(`- Cell pattern: ${input.cellPatternSummary}`);
  }

  if (input.napFindingsSummary) {
    parts.push('', 'NAP AUDIT FINDINGS:', input.napFindingsSummary);
  } else {
    parts.push('', 'NAP AUDIT FINDINGS: (not available — use generic directory framing, do not name specific directories you cannot verify)');
  }

  if (input.competitorSummary) {
    parts.push('', 'TOP COMPETITORS:', input.competitorSummary);
  }

  // Strategy-tier comparative input: when the buyer paid for a
  // 3-keyword scan we feed Claude the secondary keywords' stats so
  // the diagnosis blurb references which service angle has the
  // strongest opportunity vs. which is most contested. The roadmap
  // actions themselves are still framed around the primary keyword
  // (the buyer + strategist pick one to lean into on the call), but
  // the diagnosis sets the comparative scene.
  if (input.secondaryKeywords && input.secondaryKeywords.length > 0) {
    parts.push('', 'COMPARATIVE KEYWORDS (Strategy-tier 3-keyword scan):');
    parts.push(
      `- Primary "${input.keyword}": TurfScore ${input.currentTurfScore}/100${
        input.turfReach != null ? `, Reach ${input.turfReach.toFixed(0)}%` : ''
      }${input.turfRank != null ? `, Rank ${input.turfRank.toFixed(2)}/3` : ''}`
    );
    for (const k of input.secondaryKeywords) {
      parts.push(
        `- "${k.keyword}": TurfScore ${k.turfScore}/100${
          k.turfReach != null ? `, Reach ${k.turfReach.toFixed(0)}%` : ''
        }${k.turfRank != null ? `, Rank ${k.turfRank.toFixed(2)}/3` : ''}`
      );
    }
    parts.push(
      '',
      'In the DIAGNOSIS blurb (only), explicitly name the cross-keyword pattern: which of the three has the strongest visibility today, which is the biggest opportunity (largest gap between current TurfScore and a realistic 30-day target), and which is most contested. Keep the diagnosis to 3-4 sentences. The roadmap ACTIONS should still be framed for the primary keyword — the strategist call is where the buyer picks which keyword to lean into.'
    );
  }

  parts.push(
    '',
    'Generate the 90-day roadmap as structured JSON. 8-12 actions across 12 weeks. Foundation phase first (weeks 1-4), then Authority (5-8), then Optimization (9-12).'
  );

  return parts.join('\n');
}

// ─── Caller ────────────────────────────────────────────────────────────

export type GeneratedRoadmap = {
  diagnosis: string;
  actions: Array<
    RoadmapActionT & {
      /** Heuristic lift for this action, computed downstream from
       *  HEURISTIC_LIFTS. */
      projectedScoreLift: number;
      /** Whether this action's category is LLM-covered. Now true for
       *  every category — kept for backwards-compat. */
      llmCovered: boolean;
      /** Resolved pillar after applying the canonical category→pillar
       *  override (so a model-emitted pillar that disagrees with a
       *  fixed-pillar category is corrected here, not at the render
       *  site). */
      resolvedPillar: Pillar;
    }
  >;
  /** Sum of projectedScoreLift across actions completed in the first
   *  4 weeks (Foundation phase). This is the value stored as
   *  visibility_audits.lift_promise_target_score — what we promise
   *  in the 30-day window. */
  thirtyDayTargetLift: number;
  /** Cumulative lift if the buyer completes ALL 12 weeks. Used in
   *  the PDF page 5 projection chart. */
  ninetyDayTargetLift: number;
  /** Stable version tag for traceability. */
  generatorVersion: string;
};

/**
 * Generate a roadmap for a buyer. Calls Claude with structured output,
 * then layers the heuristic lift table on top to produce per-action
 * projected lifts. Throws on any error — caller handles the
 * fail-soft path (audit row is created without a roadmap; cron
 * pipeline can retry generation later).
 */
export async function generateRoadmap(
  input: RoadmapInput
): Promise<GeneratedRoadmap> {
  const anthropic = getAnthropic();
  const message = await anthropic.messages.parse({
    model: COACH_MODEL,
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    output_config: { format: zodOutputFormat(RoadmapOutput) },
  });

  const parsed = message.parsed_output;
  if (!parsed) {
    throw new Error(
      'Roadmap generator returned no structured output (model may have refused or hit a length limit)'
    );
  }

  // Apply the heuristic lift table. Track per-category position so
  // diminishing returns kicks in for repeat categories.
  const positionInCategory = new Map<ActionCategory, number>();
  const actionsWithLift = parsed.actions.map((action) => {
    const next = (positionInCategory.get(action.category) ?? 0) + 1;
    positionInCategory.set(action.category, next);
    const projectedScoreLift = liftForAction(action.category, next);
    // Resolve pillar: for fixed-pillar categories the canonical
    // mapping wins (model-emitted pillar can be wrong); for 'other'
    // we trust the AI's pick.
    const resolvedPillar = pillarForAction({
      category: action.category,
      aiPillar: action.pillar,
    });
    return {
      ...action,
      pillar: resolvedPillar, // overwrite the model's pillar with the resolved one
      projectedScoreLift,
      llmCovered: isLlmCovered(action.category),
      resolvedPillar,
    };
  });

  // Sort by week then by priority within week so the dashboard +
  // PDF render in the right order even if the model returned
  // out-of-order entries.
  const PRIORITY_ORDER: Record<RoadmapActionT['priority'], number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
  };
  actionsWithLift.sort((a, b) => {
    if (a.week !== b.week) return a.week - b.week;
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  });

  // Cumulative-lift math.
  const thirtyDayTargetLift = actionsWithLift
    .filter((a) => a.week <= 4)
    .reduce((sum, a) => sum + a.projectedScoreLift, 0);

  const ninetyDayTargetLift = actionsWithLift.reduce(
    (sum, a) => sum + a.projectedScoreLift,
    0
  );

  return {
    diagnosis: parsed.diagnosis,
    actions: actionsWithLift,
    thirtyDayTargetLift,
    ninetyDayTargetLift,
    generatorVersion: ROADMAP_GENERATOR_VERSION,
  };
}
