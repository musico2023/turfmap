/**
 * Industry-aware directory selection for BrightLocal NAP audits.
 *
 * Why this exists: hard-coding a single directory set means a pediatric
 * clinic gets audited on Angi / Houzz / Thumbtack (irrelevant) and the
 * AI Coach then recommends building citations there — wrong advice. Each
 * vertical has its own gravitational set of citation sites that actually
 * carry signal weight in Google's local pack for that industry.
 *
 * Profiles
 *   - Each profile is `universal_core ∪ vertical_specific`.
 *   - Universal core = directories that matter for any local business
 *     (Google, Bing, Apple Maps, Facebook, Yelp, Yellow Pages).
 *   - Vertical-specific = the highest-signal sites for that industry,
 *     drawn from public BrightLocal docs + standard local-SEO knowledge.
 *
 * Slug correctness
 *   These slugs are best-effort. BrightLocal's canonical slug list is
 *   `GET /data/v1/listings/directories`, which we'd need to page through
 *   to verify. Until then, any slug we guess wrong gets caught at audit
 *   initiate time and stored in `nap_audits.brightlocal_rejected` for
 *   debugging — the audit still proceeds on the slugs that were accepted.
 */

// All slugs below are verified against BrightLocal's canonical
// /data/v1/listings/directories endpoint (run via `npm run bl:directories`
// for ground truth). Don't add a slug to this file without confirming it
// exists there — BL rejects unknown ones at initiate time.
const UNIVERSAL_CORE = [
  'google',
  'bing',
  // BL's slug for Apple's listing service is just `apple` (https://maps.apple.com),
  // not `apple-maps`. Confirmed against canonical directory list 2026-05-03.
  'apple',
  'facebook',
  'yelp',
  'yellowpages',
] as const;

const PROFILES = {
  /** Plumbing / HVAC / roofing / electrical / landscaping / etc. The
   *  TurfMap default — matches Anthony's primary book. */
  'home-services': [
    ...UNIVERSAL_CORE,
    'bbb',
    'foursquare',
    'mapquest',
    'nextdoor',
    'angi',
    'houzz',
    'thumbtack',
    'manta',
    'superpages',
  ],

  /** Medical / dental / chiropractic / veterinary / pediatric / etc.
   *  Health directories carry strong signal in Google's medical pack. */
  'medical-healthcare': [
    ...UNIVERSAL_CORE,
    'bbb',
    'healthgrades',
    'vitals',
    'ratemds',
    'zocdoc',
    // BL slug is `doctor` (URL: https://www.doctor.com), not `doctor-com`.
    'doctor',
    'webmd',
    // `sharecare` isn't in BL's canonical list; `wellness` is the closest
    // general-health analogue (https://www.wellness.com).
    'wellness',
    'mapquest',
  ],

  /** Lawyers / attorneys / legal services. */
  legal: [
    ...UNIVERSAL_CORE,
    'bbb',
    'avvo',
    'justia',
    'findlaw',
    // BL slug is `lawyers` (URL: https://www.lawyers.com), not `lawyers-com`.
    'lawyers',
    'martindale',
    // `superlawyers` isn't in BL's canonical list; `attorneypages` is the
    // closest US legal-directory analogue.
    'attorneypages',
  ],

  /** Restaurants / cafes / bars / bakeries / catering. */
  'food-restaurant': [
    ...UNIVERSAL_CORE,
    'tripadvisor',
    'opentable',
    'foursquare',
    'mapquest',
    'nextdoor',
    'zomato',
    'doordash',
    'grubhub',
  ],

  /** Real estate brokers / agencies. */
  'real-estate': [
    ...UNIVERSAL_CORE,
    'zillow',
    // BL slug is `realtor` (URL: https://www.realtor.com), not `realtor-com`.
    'realtor',
    'redfin',
    'mapquest',
    // `trulia` isn't in BL's canonical list (Zillow Group folded it into
    // their network); `apartments` (https://www.apartments.com) is the
    // best replacement for residential property listings.
    'apartments',
  ],

  /** Auto sales / repair / detailing / tire / etc. */
  automotive: [
    ...UNIVERSAL_CORE,
    // BL slug is `cars` (URL: https://www.cars.com), not `cars-com`.
    'cars',
    'cargurus',
    'edmunds',
    // `autotrader` and `kbb` aren't in BL's canonical list. `dealerrater`
    // and `mechanicadvisor` are the strongest automotive replacements.
    'dealerrater',
    'mechanicadvisor',
    'mapquest',
  ],

  /** Tight universal-only set — used when the operator hasn't set an
   *  industry yet, so we don't burn audit credits on irrelevant
   *  directories that produce misleading "missing from" recommendations. */
  universal: [...UNIVERSAL_CORE],
} as const;

export type DirectoryProfile = keyof typeof PROFILES;

/**
 * Free-text industry → profile mapping via keyword regex. Order is
 * meaningful — earlier rules win. The list runs against the lowercased
 * `clients.industry` value with `\b` boundaries so "veterinary medical"
 * still matches medical, "auto body shop" still matches automotive, etc.
 *
 * Tweak with care: a misclassified industry produces wrong recommendations
 * via the AI Coach prompt.
 */
const INDUSTRY_RULES: Array<{ pattern: RegExp; profile: DirectoryProfile }> = [
  {
    // Medical first — "medical" appears in things like "veterinary medical".
    // Covers: medical, healthcare, clinic, doctor/doc, dental/orthodontic,
    // chiropractic, veterinary, pediatric, therapy/therapist, physician,
    // psychiatric/psychology, mental health, urgent care, optometry, etc.
    pattern:
      /\b(medical|health(care)?|clinic|doctor|dental|orthodont|chiropract|veterinar|pediatric|therap(y|ist)|physic(ian|al)|psychia|psycholog|optometr|optic|urgent ?care|nurs|rehab|pharma)\w*/i,
    profile: 'medical-healthcare',
  },
  {
    pattern: /\b(law(yer|firm)?|attorney|legal|paralegal)\b/i,
    profile: 'legal',
  },
  {
    pattern:
      /\b(restaurant|caf[eé]|bakery|cater(er|ing)|food ?(truck|service)|pizz|sushi|bistro|diner|pub|brewery|deli|tavern|grill|eatery)\b/i,
    profile: 'food-restaurant',
  },
  {
    pattern: /\b(real ?estate|realt(or|y)|broker(age)?)\b/i,
    profile: 'real-estate',
  },
  {
    pattern:
      /\b(automotive|car ?(dealer|lot|sale|repair|wash)|auto ?(repair|body|sales|parts)|mechanic|tire|transmission|detailing)\b/i,
    profile: 'automotive',
  },
  // No "home-services" pattern here — it's the explicit fallback for
  // clients whose industry is set but doesn't match any rule above.
  // The plumbing/HVAC/roofing/etc. terms are common enough in industry
  // that we just default to home-services for them rather than enumerate.
];

/** What gets returned when industry is null/empty: the safer universal
 *  set so we don't burn audit credits on the wrong vertical. */
const DEFAULT_FOR_NO_INDUSTRY: DirectoryProfile = 'universal';

/** What gets returned when industry IS set but matches no rule: home
 *  services (TurfMap's primary book). Operators in unusual verticals
 *  who want a tighter audit can just leave industry blank. */
const DEFAULT_FOR_UNMATCHED_INDUSTRY: DirectoryProfile = 'home-services';

export function inferProfileForIndustry(
  industry: string | null
): DirectoryProfile {
  if (!industry || industry.trim().length === 0) {
    return DEFAULT_FOR_NO_INDUSTRY;
  }
  for (const rule of INDUSTRY_RULES) {
    if (rule.pattern.test(industry)) return rule.profile;
  }
  return DEFAULT_FOR_UNMATCHED_INDUSTRY;
}

export function getDirectoriesForIndustry(
  industry: string | null
): readonly string[] {
  return PROFILES[inferProfileForIndustry(industry)];
}

export function listProfileNames(): DirectoryProfile[] {
  return Object.keys(PROFILES) as DirectoryProfile[];
}

export function getDirectoriesForProfile(
  profile: DirectoryProfile
): readonly string[] {
  return PROFILES[profile];
}
