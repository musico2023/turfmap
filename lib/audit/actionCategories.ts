/**
 * Action category metadata — the single source of truth for:
 *
 *   1. Which Roadmap action categories exist (also enforced by
 *      `roadmap_actions.action_category`'s CHECK constraint).
 *   2. Which categories Local Lead Machine covers as done-for-you
 *      ("📍 LLM" tag in the PDF + dashboard).
 *   3. The dashboard nudge text shown next to LLM-covered actions
 *      that are DIY-medium or DIY-hard difficulty.
 *
 * Why a single config rather than three: the three pieces of metadata
 * are coupled — if we add a new category (e.g., 'paid_ads'), we
 * always need to decide its LLM coverage AND its nudge in the same
 * commit. Splitting them invites drift.
 *
 * The AI Roadmap Generator references this file at prompt-build time
 * so the model knows the exact category names it can emit. The
 * Strategist Prep Notes generator + the dashboard UI consume the
 * nudges. The PDF generator consumes the LLM coverage flags.
 */

import type { ActionCategory } from '@/lib/supabase/types';

/** The three Local Lead Machine pillars. EVERY action a Roadmap can
 *  surface falls under one of these — there is no "outside LLM" zone
 *  in the Fourdots framework, only "this Roadmap focuses on the
 *  Visibility pillar; the strategist call covers Demand + Systems
 *  if you're pursuing full LLM."
 *
 *  - 'visibility': organic local-pack positioning (GBP, NAP,
 *    directory consistency, schema, photos, local SEO content)
 *  - 'demand': paid traffic + conversion (Google Ads, Meta Ads,
 *    landing funnels, creative refresh)
 *  - 'systems': lead capture + workflow infrastructure (review
 *    velocity automation, CRM, email follow-up, attribution
 *    reporting)
 */
export type Pillar = 'visibility' | 'demand' | 'systems';

export type ActionCategoryConfig = {
  /** Stable enum value — matches the `action_category` CHECK constraint. */
  id: ActionCategory;
  /** Human-readable label used in the PDF + dashboard. */
  label: string;
  /** Brief description fed to the AI prompt so the model picks the
   *  right category for ambiguous actions. */
  promptDescription: string;
  /** Which LLM pillar this category lives under. Drives the V/D/S
   *  badge in the PDF + dashboard. For categories with a fixed
   *  pillar (everything except 'other'), this is the canonical
   *  source-of-truth: the AI may emit a different pillar value
   *  for these and we override at the render site. For 'other',
   *  the AI picks pillar at generation time since the action
   *  could be demand (landing pages), systems (CRM), or
   *  visibility (long-tail local SEO content). */
  pillar: Pillar | null;
  /** TRUE if Local Lead Machine handles this category as part of
   *  the done-for-you implementation. With the pillar redesign this
   *  is effectively true for ALL categories (LLM covers all three
   *  pillars), but kept for backwards-compat with existing call
   *  sites that gate dashboard nudges on it. */
  llmCovered: boolean;
  /** Dashboard nudge text shown on actions tagged DIY-medium or
   *  DIY-hard. Empty for categories where llmCovered=false (no
   *  nudge to render). All nudges link to fourdots.io/home-services
   *  via the dashboard component, so the text shouldn't include
   *  the URL — just the operator-facing copy. */
  dashboardNudge: string;
};

export const ACTION_CATEGORIES: ActionCategoryConfig[] = [
  {
    id: 'review_velocity',
    label: 'Review velocity',
    promptDescription:
      "Driving review volume + recency on Google Business Profile via a Systems-pillar workflow: post-job SMS/email automation, owner-response cadence, incentive structures. Categorize any action centered on the buyer's review count or response rate here.",
    pillar: 'systems',
    llmCovered: true,
    dashboardNudge:
      'Most operators struggle with this. LLM includes automated SMS + email post-job to drive review velocity. See if you qualify →',
  },
  {
    id: 'directory_claiming',
    label: 'Directory claiming',
    promptDescription:
      "Claiming and verifying business listings across third-party directories (Yelp, BBB, Angi, HomeAdvisor, vertical-specific directories like Houzz for renovation). Includes initial claim + ongoing monthly monitoring.",
    pillar: 'visibility',
    llmCovered: true,
    dashboardNudge:
      'Citation work is tedious. LLM handles directory consistency across 30+ sites with monthly monitoring. See if you qualify →',
  },
  {
    id: 'gbp_optimization',
    label: 'GBP optimization',
    promptDescription:
      'Tightening Google Business Profile fields: primary + additional categories, services, attributes, descriptions, hours, service-area definitions. Excludes photos (separate category) and reviews (separate category).',
    pillar: 'visibility',
    llmCovered: true,
    dashboardNudge:
      "GBP optimization takes 6-10 hours done right. LLM's full GBP rebuild is included in implementation. See if you qualify →",
  },
  {
    id: 'gbp_photos',
    label: 'GBP photos',
    promptDescription:
      'Adding and refreshing GBP photos — interior, exterior, team, completed-job photos. Most operators skip this; well-photographed listings get 35% more clicks per Google.',
    pillar: 'visibility',
    llmCovered: true,
    dashboardNudge:
      'Photo system is the most-skipped action by operators. LLM handles monthly photo collection, optimization, and upload. See if you qualify →',
  },
  {
    id: 'schema_integration',
    label: 'Schema integration',
    promptDescription:
      'Adding LocalBusiness structured data (JSON-LD) to the operator\'s website. Tightly coupled to the buyer having or building a conversion-grade website; less applicable for buyers running pure GBP-only.',
    pillar: 'visibility',
    llmCovered: true,
    dashboardNudge:
      'Schema integration usually needs a developer. LLM ships this with the conversion funnel. See if you qualify →',
  },
  {
    id: 'nap_consistency',
    label: 'NAP consistency',
    promptDescription:
      "Fixing Name/Address/Phone inconsistencies across directories where the buyer is already listed. Specifically does NOT include claiming new directories — that's directory_claiming.",
    pillar: 'visibility',
    llmCovered: true,
    dashboardNudge:
      'NAP fixes across multiple directories are finicky. LLM monitors and fixes inconsistencies monthly. See if you qualify →',
  },
  {
    id: 'other',
    label: 'Other',
    promptDescription:
      "Catchall for actions that don't fit a named Visibility-pillar category — most commonly demand-pillar work (seasonal landing pages, paid-ads strategy, conversion funnels) or systems-pillar work (CRM setup, email follow-up sequences, attribution tracking). When you use this category, ALWAYS set the `pillar` field explicitly to demand or systems (or visibility for an unusual local-SEO content action).",
    // null pillar — AI picks at generation time. Render site reads
    // the AI's choice rather than mapping from category.
    pillar: null,
    llmCovered: true,
    dashboardNudge: '',
  },
];

/** Convenience map for O(1) category lookup by id. Built once at
 *  module load — `ACTION_CATEGORIES` is the source of truth, this
 *  is just a reader's index. */
export const ACTION_CATEGORY_BY_ID: Readonly<
  Record<ActionCategory, ActionCategoryConfig>
> = Object.freeze(
  ACTION_CATEGORIES.reduce(
    (acc, c) => {
      acc[c.id] = c;
      return acc;
    },
    {} as Record<ActionCategory, ActionCategoryConfig>
  )
);

/** All category IDs the AI Roadmap Generator is allowed to emit.
 *  Used in the prompt to constrain Claude's output + as the runtime
 *  validator after the response lands. */
export const ALLOWED_ACTION_CATEGORIES: readonly ActionCategory[] =
  ACTION_CATEGORIES.map((c) => c.id);

/** TRUE if the category is covered by Local Lead Machine. Equivalent
 *  to ACTION_CATEGORY_BY_ID[id].llmCovered, exposed as a function
 *  for use at the row-insert site (where we set llm_covered on
 *  roadmap_actions). */
export function isLlmCovered(category: ActionCategory): boolean {
  return ACTION_CATEGORY_BY_ID[category].llmCovered;
}

/**
 * Resolve the LLM pillar for a given action.
 *
 * For named categories (review_velocity, gbp_*, etc.) the pillar is
 * deterministic — return ACTION_CATEGORY_BY_ID[category].pillar.
 * For 'other', the pillar is whatever the AI picked at generation
 * time (passed in as `aiPillar`). If the AI didn't supply one, fall
 * back to 'demand' since the most common 'other' actions in
 * practice (seasonal landing pages, paid-ads strategy) live there.
 */
export function pillarForAction(args: {
  category: ActionCategory;
  /** AI-supplied pillar for the action. Used only when category is
   *  'other' — for fixed-pillar categories we override with the
   *  canonical mapping to keep the document accurate even if the
   *  model picks oddly. */
  aiPillar?: Pillar | null;
}): Pillar {
  const config = ACTION_CATEGORY_BY_ID[args.category];
  if (config.pillar) return config.pillar;
  // 'other' branch — trust AI's pick if present, else fall back.
  return args.aiPillar ?? 'demand';
}

/** Display labels for the pillar badge on the PDF + dashboard.
 *  Single-letter monogram keeps the badge column compact. */
export const PILLAR_LABEL: Readonly<Record<Pillar, string>> = Object.freeze({
  visibility: 'V',
  demand: 'D',
  systems: 'S',
});

/** Full names for legends + body copy. */
export const PILLAR_FULL_LABEL: Readonly<Record<Pillar, string>> = Object.freeze({
  visibility: 'Visibility',
  demand: 'Demand',
  systems: 'Systems',
});

/** Dashboard nudge for an action in a given category at a given
 *  difficulty. Returns null when no nudge should render — either
 *  because the action is easy enough that the operator can knock it
 *  out (DIY-easy), or because the category has no associated nudge
 *  (e.g., 'other' actions don't ship with a canned LLM pitch since
 *  the segue depends on which pillar the action lives under). The
 *  dashboard component reads this + decides whether to show the
 *  inline "See if you qualify →" CTA. */
export function nudgeForAction(args: {
  category: ActionCategory;
  difficulty: 'DIY-easy' | 'DIY-medium' | 'DIY-hard';
}): string | null {
  if (args.difficulty === 'DIY-easy') return null;
  const config = ACTION_CATEGORY_BY_ID[args.category];
  if (!config.llmCovered) return null;
  // No-nudge categories ('other') return null rather than ''.
  if (!config.dashboardNudge) return null;
  return config.dashboardNudge;
}
