/**
 * Directory roster for the DFS-based citation checker.
 *
 * Different from lib/brightlocal/directories.ts — BL operates against
 * its proprietary directory IDs (`yellowpages`, `superpages`, etc.).
 * The DFS checker queries Google with `site:{domain}` filters, so the
 * roster is keyed by the directory's public-facing root domain.
 *
 * Coverage philosophy: cover the big-12 home-services directories
 * that drive >90% of local-SEO citation impact. Niche vertical
 * directories (Healthgrades for medical, Avvo for legal) are added
 * vertical-by-vertical in v2.
 */

export type DfsDirectoryProfile = 'universal' | 'home-services' | 'medical';

export type DfsDirectory = {
  /** Stable id for storage / comparison. Used as the `directory`
   *  field on the NapAuditFindings rows so downstream code is
   *  domain-agnostic. */
  id: string;
  /** Display name for the dashboard + AI Coach. */
  label: string;
  /** Google site: filter target. Required when probe='site_serp'.
   *  Unused when probe='local_pack' (GBP). */
  domain?: string;
  /** Authority weight for missing-listing priority. */
  priority: 'high' | 'medium' | 'low';
  /** Country availability — CAN-restricted directories don't get
   *  audited for US buyers and vice versa. 'all' means audit
   *  everywhere. */
  countries: 'all' | 'CAN' | 'USA';
  /** Which probe strategy to use:
   *    site_serp  — default; Google organic SERP with `site:{domain}`
   *                 filter. Works for any directory Google indexes
   *                 (Yelp, BBB, Facebook, Apple Maps, etc.).
   *    local_pack — query Google plainly (no site: filter), parse
   *                 the local_pack items in the SERP response. Used
   *                 for Google Business Profile, which can't be
   *                 site:-filtered because google.com/maps URLs
   *                 reject path-based site: syntax. */
  probe?: 'site_serp' | 'local_pack';
};

/** Big-12: the universal directory set audited for every buyer
 *  regardless of vertical. Order matters — higher-priority entries
 *  surface first in the dashboard's NAP findings table.
 *
 *  Google Business Profile uses a different probe strategy
 *  (probe='local_pack') because Google's site: filter rejects path-
 *  based queries (`site:google.com/maps` is invalid syntax). Instead
 *  we issue a plain organic SERP query for the business name + city
 *  and parse the local_pack items — those ARE GBP listings. Same
 *  DFS endpoint, same per-call cost; different parse path handled
 *  in dfsChecker.probeDirectory. */
const UNIVERSAL: DfsDirectory[] = [
  { id: 'google_business', label: 'Google Business Profile',                              priority: 'high', countries: 'all', probe: 'local_pack' },
  { id: 'yelp',            label: 'Yelp',                   domain: 'yelp.com',           priority: 'high', countries: 'all' },
  { id: 'facebook',        label: 'Facebook',               domain: 'facebook.com',       priority: 'high', countries: 'all' },
  { id: 'bbb',             label: 'BBB',                    domain: 'bbb.org',            priority: 'high', countries: 'all' },
  { id: 'apple_maps',      label: 'Apple Maps',             domain: 'maps.apple.com',     priority: 'medium', countries: 'all' },
  { id: 'bing_places',     label: 'Bing Places',            domain: 'bingplaces.com',     priority: 'medium', countries: 'all' },
  { id: 'foursquare',      label: 'Foursquare',             domain: 'foursquare.com',     priority: 'medium', countries: 'all' },
  { id: 'yellowpages_us',  label: 'YellowPages (US)',       domain: 'yellowpages.com',    priority: 'medium', countries: 'USA' },
  { id: 'yellowpages_ca',  label: 'YellowPages.ca',         domain: 'yellowpages.ca',     priority: 'medium', countries: 'CAN' },
  { id: 'nextdoor',        label: 'Nextdoor',               domain: 'nextdoor.com',       priority: 'low',    countries: 'all' },
];

/** Home-services trade additions. Audited for plumbers, HVAC,
 *  roofers, landscapers, contractors. */
const HOME_SERVICES_ADD: DfsDirectory[] = [
  { id: 'angi',         label: 'Angi (Angie\'s List)', domain: 'angi.com',         priority: 'high',   countries: 'USA' },
  { id: 'homeadvisor',  label: 'HomeAdvisor',          domain: 'homeadvisor.com',  priority: 'high',   countries: 'USA' },
  { id: 'thumbtack',    label: 'Thumbtack',            domain: 'thumbtack.com',    priority: 'medium', countries: 'USA' },
  { id: 'homestars',    label: 'HomeStars',            domain: 'homestars.com',    priority: 'high',   countries: 'CAN' },
];

/** Medical trade additions. Used only when industry maps to medical. */
const MEDICAL_ADD: DfsDirectory[] = [
  { id: 'healthgrades', label: 'Healthgrades',         domain: 'healthgrades.com', priority: 'high',   countries: 'all' },
  { id: 'webmd',        label: 'WebMD Care',           domain: 'doctor.webmd.com', priority: 'medium', countries: 'all' },
  { id: 'ratemds',      label: 'RateMDs',              domain: 'ratemds.com',      priority: 'medium', countries: 'all' },
];

/** Vertical → directory set. Always start with UNIVERSAL, then
 *  augment based on industry. */
export function directoriesForProfile(
  profile: DfsDirectoryProfile,
  countryCode: string | null = 'USA'
): DfsDirectory[] {
  let dirs: DfsDirectory[];
  switch (profile) {
    case 'home-services':
      dirs = [...UNIVERSAL, ...HOME_SERVICES_ADD];
      break;
    case 'medical':
      dirs = [...UNIVERSAL, ...MEDICAL_ADD];
      break;
    case 'universal':
    default:
      dirs = UNIVERSAL;
      break;
  }
  // Country filter: drop directories that aren't relevant for the
  // buyer's country. Saves DFS calls + avoids surfacing "missing
  // from YellowPages.ca" findings on US buyers.
  //
  // Normalize to the alpha-3 codes the directory table uses ('USA' /
  // 'CAN'). Clients enriched from Google Places carry alpha-2 codes
  // ('US' / 'CA'), and a raw compare ('CA' === 'CAN') silently failed —
  // so the entire home-services vertical (HomeStars for CAN, Angi /
  // HomeAdvisor / Thumbtack for USA) was filtered out for those clients.
  const raw = (countryCode ?? 'USA').toUpperCase();
  const country = raw === 'CA' ? 'CAN' : raw === 'US' ? 'USA' : raw;
  return dirs.filter((d) => d.countries === 'all' || d.countries === country);
}

/** Free-text industry → DfsDirectoryProfile. Mirrors the same intent
 *  as lib/brightlocal/directories.ts's inferProfileForIndustry, but
 *  the DFS-checker's vertical roster is narrower (we only ship
 *  vertical additions for home-services and medical today; restaurant
 *  / real-estate / automotive / legal use the UNIVERSAL set only).
 *
 *  Industries are matched in priority order:
 *    1. Explicit non-home verticals (restaurant, medical, legal, etc.)
 *       → these short-circuit to 'universal' or 'medical' so they
 *       never pick up HOME_SERVICES_ADD entries (Homestars / Angi /
 *       HomeAdvisor / Thumbtack). This was the catalyst — a
 *       restaurant audit was surfacing HomeStars as a "missing
 *       citation" because the function used to default unknown
 *       industries to 'home-services'.
 *    2. Explicit home-services regex (plumbing / HVAC / roofing /
 *       etc.) → 'home-services' profile.
 *    3. Anything still unmatched → 'universal'. Operators who want
 *       a tighter vertical audit should set clients.industry to a
 *       value that matches one of the regexes above.
 */
export function inferDfsProfile(industry: string | null): DfsDirectoryProfile {
  if (!industry) return 'universal';
  const i = industry.toLowerCase();

  // Explicit non-home verticals — match BEFORE the home-services
  // regex so multi-word industries like "restaurant construction"
  // (rare but real) don't slip into home-services. Order within
  // this block doesn't matter; the regexes are disjoint.
  if (
    /\b(restaurant|caf[eé]|bakery|cater(er|ing)|food ?(truck|service)|pizz|sushi|bistro|diner|pub|brewery|deli|tavern|grill|eatery)\b/.test(
      i
    )
  ) {
    return 'universal';
  }
  if (/\b(law(yer|firm)?|attorney|legal|paralegal)\b/.test(i)) {
    return 'universal';
  }
  if (/\b(real ?estate|realt(or|y)|broker(age)?)\b/.test(i)) {
    return 'universal';
  }
  if (
    /\b(automotive|car ?(dealer|lot|sale|repair|wash)|auto ?(repair|body|sales|parts)|mechanic|tire|transmission|detailing)\b/.test(
      i
    )
  ) {
    return 'universal';
  }

  if (/\b(medical|health(care)?|clinic|doctor|dental|orthodont|chiropract|veterinar|pediatric|therap(y|ist)|physic(ian|al)|psychia|psycholog|optometr|optic|urgent ?care|nurs|rehab|pharma)/.test(i)) {
    return 'medical';
  }

  // Stem-matched: leading \b, NO trailing \b, so suffixed forms route
  // here instead of falling through to 'universal'. The old trailing \b
  // silently misrouted "painting"/"plumbing"/"roofing"/"landscaping"
  // (the -ing forms don't end on a boundary after the stem), so every
  // home-services client got the generic 'universal' directory set — no
  // HomeStars/Angi/Houzz. Mirror of the lib/brightlocal/directories.ts
  // fix. Also covers remodeling/cabinet/countertop verticals.
  if (
    /\b(plumb|hvac|roof|landscap|lawn|construction|contractor|home ?build|electric|paint|clean|restoration|handyman|garage|locksmith|blind|carpet|appliance|tree|gutter|deck|fenc|pool|pest|septic|driveway|concrete|drywall|pressure|wash|remodel|renovat|cabinet|countertop|floor|tile|window|door)/.test(
      i
    )
  ) {
    return 'home-services';
  }

  return 'universal';
}
