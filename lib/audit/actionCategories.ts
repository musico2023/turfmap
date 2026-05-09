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

export type ActionCategoryConfig = {
  /** Stable enum value — matches the `action_category` CHECK constraint. */
  id: ActionCategory;
  /** Human-readable label used in the PDF + dashboard. */
  label: string;
  /** Brief description fed to the AI prompt so the model picks the
   *  right category for ambiguous actions. */
  promptDescription: string;
  /** TRUE if Local Lead Machine handles this category as part of
   *  the done-for-you implementation. Drives the 📍 LLM tag in the
   *  PDF and the presence/absence of the dashboard nudge. */
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
      "Driving review volume + recency on Google Business Profile. Includes setting up a post-job request flow (SMS or email), incentivizing reviews, responding to existing reviews. Categorize any action centered on the buyer's review count or response rate here.",
    llmCovered: true,
    dashboardNudge:
      'Most operators struggle with this. LLM includes automated SMS + email post-job to drive review velocity. See if you qualify →',
  },
  {
    id: 'directory_claiming',
    label: 'Directory claiming',
    promptDescription:
      "Claiming and verifying business listings across third-party directories (Yelp, BBB, Angi, HomeAdvisor, vertical-specific directories like Houzz for renovation). Includes initial claim + ongoing monthly monitoring.",
    llmCovered: true,
    dashboardNudge:
      'Citation work is tedious. LLM handles directory consistency across 30+ sites with monthly monitoring. See if you qualify →',
  },
  {
    id: 'gbp_optimization',
    label: 'GBP optimization',
    promptDescription:
      'Tightening Google Business Profile fields: primary + additional categories, services, attributes, descriptions, hours, service-area definitions. Excludes photos (separate category) and reviews (separate category).',
    llmCovered: true,
    dashboardNudge:
      "GBP optimization takes 6-10 hours done right. LLM's full GBP rebuild is included in implementation. See if you qualify →",
  },
  {
    id: 'gbp_photos',
    label: 'GBP photos',
    promptDescription:
      'Adding and refreshing GBP photos — interior, exterior, team, completed-job photos. Most operators skip this; well-photographed listings get 35% more clicks per Google.',
    llmCovered: true,
    dashboardNudge:
      'Photo system is the most-skipped action by operators. LLM handles monthly photo collection, optimization, and upload. See if you qualify →',
  },
  {
    id: 'schema_integration',
    label: 'Schema integration',
    promptDescription:
      'Adding LocalBusiness structured data (JSON-LD) to the operator\'s website. Tightly coupled to the buyer having or building a conversion-grade website; less applicable for buyers running pure GBP-only.',
    llmCovered: true,
    dashboardNudge:
      'Schema integration usually needs a developer. LLM ships this with the conversion funnel. See if you qualify →',
  },
  {
    id: 'nap_consistency',
    label: 'NAP consistency',
    promptDescription:
      "Fixing Name/Address/Phone inconsistencies across directories where the buyer is already listed. Specifically does NOT include claiming new directories — that's directory_claiming.",
    llmCovered: true,
    dashboardNudge:
      'NAP fixes across multiple directories are finicky. LLM monitors and fixes inconsistencies monthly. See if you qualify →',
  },
  {
    id: 'other',
    label: 'Other',
    promptDescription:
      "Catchall for buyer-specific actions that don't fit a named category — e.g., trade-specific opportunities (HVAC seasonal-prep landing page, roofing storm-season SEO). Use sparingly; prefer a named category when one applies.",
    llmCovered: false,
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

/** Dashboard nudge for an action in a given category at a given
 *  difficulty. Returns null when no nudge should render — either
 *  because the category isn't LLM-covered or the action is easy
 *  enough that the operator can knock it out (DIY-easy). The
 *  dashboard component reads this + decides whether to show the
 *  inline "See if you qualify →" CTA. */
export function nudgeForAction(args: {
  category: ActionCategory;
  difficulty: 'DIY-easy' | 'DIY-medium' | 'DIY-hard';
}): string | null {
  if (args.difficulty === 'DIY-easy') return null;
  const config = ACTION_CATEGORY_BY_ID[args.category];
  if (!config.llmCovered) return null;
  return config.dashboardNudge;
}
