/**
 * Per-vertical missing-directory priority for NAP audit findings.
 *
 * The audit's `missing` list previously tagged every directory the same
 * way: priority='medium'. The AI Coach's system prompt teaches it to
 * weight high-priority misses more, but nothing was actually flagging
 * any directory as high — so the coach treated all gaps as equal noise.
 *
 * Reality: missing-from-Healthgrades is catastrophic for a pediatric
 * clinic and irrelevant for a roofer. Missing-from-Angi is the inverse.
 * This module lets the matcher tag the right directories per vertical
 * so the coach surfaces the gaps that actually matter.
 *
 * Tagging rules:
 *   - high   → vertical-defining citation site (Healthgrades for medical,
 *              Angi for home services, Avvo for legal, etc.)
 *   - medium → universal-core directory or vertical-relevant but not
 *              gravitational (Yellow Pages, BBB, Foursquare, etc.)
 *   - low    → reserved for sibling-occupied (set elsewhere) — directories
 *              the brand IS already on via another location
 *
 * The high set is intentionally tight (3-5 directories per vertical).
 * Tagging too many as high diminishes the signal to Claude, which then
 * treats them all as medium-equivalent and produces generic advice.
 */

import { inferProfileForIndustry } from '@/lib/brightlocal/directories';

/**
 * The vertical-gravitational directory slugs per profile. A directory
 * not in this set defaults to 'medium' priority when missing.
 */
const HIGH_PRIORITY_BY_PROFILE: Record<string, readonly string[]> = {
  // Universal core that matters for any vertical — search engines and
  // the largest review aggregators. Missing any of these is always
  // high-priority regardless of industry.
  _universal: ['google', 'apple', 'bing', 'yelp', 'facebook'],

  // Home services — Angi is the dominant lead-gen pipe; HomeAdvisor,
  // Houzz, Thumbtack each carry significant trust signal in their niche.
  // BBB matters more for trade-license trust than for restaurants etc.
  'home-services': ['angi', 'houzz', 'thumbtack', 'bbb'],

  // Medical / healthcare — Healthgrades + Vitals + Zocdoc + WebMD are
  // the gravitational sites for patient discovery. RateMDs is significant
  // in Canada specifically.
  'medical-healthcare': [
    'healthgrades',
    'vitals',
    'zocdoc',
    'webmd',
    'ratemds',
  ],

  // Legal — Avvo is the dominant attorney directory; Justia + FindLaw +
  // Martindale carry historical trust and are cited heavily in legal
  // SERPs.
  legal: ['avvo', 'justia', 'findlaw', 'martindale'],

  // Food / restaurant — TripAdvisor + OpenTable are deal-breakers for
  // discovery + booking. DoorDash + GrubHub matter for delivery-heavy
  // operators.
  'food-restaurant': ['tripadvisor', 'opentable', 'doordash'],

  // Real estate — Zillow + Realtor.com are non-negotiable for residential
  // listings. Redfin matters in select metros.
  'real-estate': ['zillow', 'realtor', 'redfin'],

  // Automotive — Cars.com + DealerRater for sales/dealers; CarGurus for
  // pricing transparency. Edmunds historically heavy.
  automotive: ['cars', 'cargurus', 'dealerrater'],
};

/**
 * Decide a missing directory's priority given the client's industry.
 * Returns 'high' for vertical-gravitational sites, 'medium' otherwise.
 * (The 'low' tier is reserved for sibling-occupied directories and is
 * set in summarizeFindings, not here.)
 */
export function priorityForMissingDirectory(
  directory: string,
  industry: string | null
): 'high' | 'medium' {
  const universalHigh = HIGH_PRIORITY_BY_PROFILE._universal;
  if (universalHigh.includes(directory)) return 'high';

  const profile = inferProfileForIndustry(industry);
  const profileHigh = HIGH_PRIORITY_BY_PROFILE[profile] ?? [];
  if (profileHigh.includes(directory)) return 'high';

  return 'medium';
}
