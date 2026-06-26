/**
 * Industry-aware keyword suggestions for the tracked-keyword input.
 *
 * Why this exists: every TurfMap client tracks 1-5 keywords, and the
 * patterns are highly predictable per industry — a plumber tracks
 * "plumber [city]" / "emergency plumber [city]" / "drain cleaning [city]";
 * a pediatric clinic tracks "pediatrician [city]" / "pediatric clinic
 * [city]". Typing those by hand is error-prone (especially across
 * multiple locations) and slows down onboarding.
 *
 * Compose: stem (per industry) × location.city → suggestion.
 *
 * Stems are deliberately stripped of "near me" / "best" / "top" prefixes
 * — those are heavily geo-modified by Google and the geo-grid scan
 * already simulates the searcher's location, so a "near me" query from
 * each grid cell behaves the same as a "[stem] [city]" query.
 */

const INDUSTRY_STEMS: Record<string, string[]> = {
  // ─── Home services ─────────────────────────────────────────────────
  plumbing: [
    'plumber',
    'emergency plumber',
    'plumbing repair',
    'drain cleaning',
    'water heater repair',
  ],
  hvac: [
    'hvac repair',
    'ac repair',
    'furnace repair',
    'heating and cooling',
    'hvac contractor',
  ],
  roofing: [
    'roofer',
    'roof repair',
    'roofing company',
    'roof replacement',
    'roof leak repair',
  ],
  electrical: [
    'electrician',
    'emergency electrician',
    'electrical contractor',
    'electrical repair',
  ],
  landscaping: [
    'landscaper',
    'lawn care',
    'landscape design',
    'lawn maintenance',
    'tree service',
  ],
  pestcontrol: [
    'pest control',
    'exterminator',
    'termite control',
    'rodent control',
    'bed bug exterminator',
  ],
  cleaning: [
    'house cleaning',
    'maid service',
    'cleaning service',
    'office cleaning',
    'deep cleaning',
  ],
  garagedoor: [
    'garage door repair',
    'garage door installation',
    'garage door opener',
  ],
  locksmith: ['locksmith', '24 hour locksmith', 'emergency locksmith'],
  painting: ['painter', 'house painting', 'interior painting', 'exterior painting'],
  flooring: ['flooring', 'hardwood flooring', 'flooring installation', 'tile installation'],
  fencing: ['fence company', 'fence installation', 'fence repair'],
  concrete: ['concrete contractor', 'concrete repair', 'concrete driveway'],
  pressurewashing: ['pressure washing', 'power washing', 'driveway cleaning'],
  windowcleaning: ['window cleaning', 'window washing'],
  poolservice: ['pool service', 'pool cleaning', 'pool repair'],
  septic: ['septic service', 'septic tank pumping', 'septic repair'],
  appliancerepair: ['appliance repair', 'refrigerator repair', 'washer repair', 'dryer repair'],

  // ─── Medical / Healthcare ──────────────────────────────────────────
  pediatric: [
    'pediatrician',
    'pediatric clinic',
    'child doctor',
    'kids doctor',
    'pediatric care',
  ],
  dental: [
    'dentist',
    'emergency dentist',
    'cosmetic dentist',
    'dental clinic',
    'family dentist',
  ],
  orthodontic: [
    'orthodontist',
    'braces',
    'invisalign',
    'orthodontic clinic',
  ],
  chiropractic: [
    'chiropractor',
    'chiropractic clinic',
    'back pain treatment',
  ],
  veterinary: [
    'veterinarian',
    'vet clinic',
    'animal hospital',
    'emergency vet',
  ],
  optometry: ['optometrist', 'eye doctor', 'eye exam', 'vision care'],
  physicaltherapy: [
    'physical therapy',
    'physical therapist',
    'sports therapy',
    'rehab clinic',
  ],
  dermatology: ['dermatologist', 'skin doctor', 'dermatology clinic'],
  urgentcare: ['urgent care', 'walk in clinic', 'after hours clinic'],
  // Catch-all medical when the more specific patterns don't match
  medical: [
    'doctor',
    'family doctor',
    'walk in clinic',
    'medical clinic',
  ],

  // ─── Legal ──────────────────────────────────────────────────────────
  personalinjury: [
    'personal injury lawyer',
    'car accident lawyer',
    'injury attorney',
  ],
  family: ['family lawyer', 'divorce attorney', 'child custody lawyer'],
  criminaldefense: [
    'criminal defense lawyer',
    'criminal lawyer',
    'dui attorney',
  ],
  estateplanning: ['estate planning lawyer', 'wills and estates lawyer'],
  realestate_legal: ['real estate lawyer', 'property lawyer'],
  legal: ['lawyer', 'attorney', 'law firm'],

  // ─── Food / Restaurant ─────────────────────────────────────────────
  restaurant: ['restaurant', 'dinner', 'family restaurant'],
  pizza: ['pizza', 'pizza delivery', 'pizzeria'],
  cafe: ['cafe', 'coffee shop', 'breakfast'],
  bakery: ['bakery', 'cake shop', 'wedding cakes'],

  // ─── Real estate ───────────────────────────────────────────────────
  realestate: [
    'real estate agent',
    'realtor',
    'homes for sale',
    'real estate broker',
  ],

  // ─── Automotive ────────────────────────────────────────────────────
  automotive: [
    'auto repair',
    'mechanic',
    'oil change',
    'brake repair',
  ],
  autobody: ['auto body shop', 'collision repair', 'car painting'],
  tireshop: ['tire shop', 'tire repair', 'tire installation'],
};

/** Pattern → stem-key. Order matters: more specific matches must come
 *  before more general ones (e.g. 'pediatric' before 'medical'). */
const INDUSTRY_PATTERNS: Array<{
  pattern: RegExp;
  key: keyof typeof INDUSTRY_STEMS;
}> = [
  // Medical specifics first
  { pattern: /\bpediatric/i, key: 'pediatric' },
  { pattern: /\borthodont/i, key: 'orthodontic' },
  { pattern: /\b(dental|dentist)/i, key: 'dental' },
  { pattern: /\bchiropract/i, key: 'chiropractic' },
  { pattern: /\b(veterinar|vet\b|animal hospital)/i, key: 'veterinary' },
  { pattern: /\b(optometr|eye care|eye doctor)/i, key: 'optometry' },
  { pattern: /\b(physical therap|physiotherap|rehab)/i, key: 'physicaltherapy' },
  { pattern: /\b(dermatolog|skin)/i, key: 'dermatology' },
  { pattern: /\b(urgent ?care|walk[- ]in)/i, key: 'urgentcare' },
  { pattern: /\b(medical|health|clinic|doctor|therapy|physician|nurs)/i, key: 'medical' },

  // Legal specifics
  { pattern: /\b(personal injury|car accident|injury)/i, key: 'personalinjury' },
  { pattern: /\b(family lawyer|divorce|child custody)/i, key: 'family' },
  { pattern: /\b(criminal|dui)/i, key: 'criminaldefense' },
  { pattern: /\b(estate planning|wills)/i, key: 'estateplanning' },
  { pattern: /\b(real estate law)/i, key: 'realestate_legal' },
  { pattern: /\b(law(yer|firm)?|attorney|legal|paralegal)/i, key: 'legal' },

  // Food specifics
  { pattern: /\b(pizza|pizzeria)/i, key: 'pizza' },
  { pattern: /\b(caf[eé]|coffee)/i, key: 'cafe' },
  { pattern: /\bbakery/i, key: 'bakery' },
  { pattern: /\b(restaurant|bistro|diner|grill|pub|tavern)/i, key: 'restaurant' },

  // Real estate
  { pattern: /\b(real ?estate|realt(or|y))/i, key: 'realestate' },

  // Automotive specifics
  { pattern: /\b(auto body|collision)/i, key: 'autobody' },
  { pattern: /\btire\b/i, key: 'tireshop' },
  { pattern: /\b(automotive|auto|mechanic|car repair)/i, key: 'automotive' },

  // Home services specifics
  { pattern: /\bplumb/i, key: 'plumbing' },
  { pattern: /\b(hvac|heating|air condition|cooling|furnace)/i, key: 'hvac' },
  { pattern: /\broof/i, key: 'roofing' },
  { pattern: /\belectric/i, key: 'electrical' },
  { pattern: /\b(landscape|lawn|tree care)/i, key: 'landscaping' },
  { pattern: /\b(pest|exterminat)/i, key: 'pestcontrol' },
  { pattern: /\bcleaning/i, key: 'cleaning' },
  { pattern: /\bgarage door/i, key: 'garagedoor' },
  { pattern: /\block/i, key: 'locksmith' },
  { pattern: /\bpaint/i, key: 'painting' },
  { pattern: /\bfloor/i, key: 'flooring' },
  { pattern: /\bfence|fencing/i, key: 'fencing' },
  { pattern: /\bconcrete/i, key: 'concrete' },
  { pattern: /\bpressure washing/i, key: 'pressurewashing' },
  { pattern: /\bwindow cleaning/i, key: 'windowcleaning' },
  { pattern: /\bpool/i, key: 'poolservice' },
  { pattern: /\bseptic/i, key: 'septic' },
  { pattern: /\bappliance/i, key: 'appliancerepair' },
];

/** Resolve an industry/category string to its INDUSTRY_STEMS key, or null
 *  when no pattern matches (novel vertical). Extracted so both the legacy
 *  stem helper and the local-candidate ranker share one resolver. */
export function matchIndustryKey(
  industry: string | null
): keyof typeof INDUSTRY_STEMS | null {
  if (!industry || industry.trim().length === 0) return null;
  const trimmed = industry.trim();
  for (const rule of INDUSTRY_PATTERNS) {
    if (rule.pattern.test(trimmed)) return rule.key;
  }
  return null;
}

export function getKeywordStems(industry: string | null): string[] {
  if (!industry || industry.trim().length === 0) return [];
  const key = matchIndustryKey(industry);
  if (key) return INDUSTRY_STEMS[key] ?? [];
  // No pattern matched — fall back to the literal industry word as a
  // single stem so suggestions still surface for novel verticals.
  return [industry.trim().toLowerCase()];
}

/**
 * Returns up to 6 clickable suggestions composed of `<stem> <city>`,
 * lowercased and trimmed. Empty when industry+city aren't both provided.
 */
export function buildKeywordSuggestions(
  industry: string | null,
  city: string | null
): string[] {
  const stems = getKeywordStems(industry);
  if (stems.length === 0) return [];
  const place = (city ?? '').trim();
  if (place.length === 0) return stems.slice(0, 6).map((s) => s.toLowerCase());
  return stems
    .slice(0, 6)
    .map((s) => `${s} ${place}`.toLowerCase().replace(/\s+/g, ' '));
}

// ─── Local keyword candidate ranking (geo-grid selection feeder) ──────
//
// Powers the free-scan auto-suggestion: given a resolved business's
// category + city, produce a ranked list of grid-appropriate keyword
// candidates and let the intake auto-select the top one.
//
// DESIGN (deliberate, per the "grid already simulates location" rule
// documented at the top of this file): we do NOT fan out geo-suffixes
// ("near me" / "{neighborhood}" / "best {x}"). Those scan IDENTICALLY
// from each grid pin and would just multiply expensive grid runs for the
// same heatmap. The axis that actually varies the local pack is the
// SERVICE term (attic vs spray-foam vs removal) and the intent type — so
// we fan out on service × intent. The city is a DISPLAY label on the
// keyword, not a separate candidate.
//
// MVP only emits 'service'-intent candidates: a commercial "{x} cost"
// query usually does NOT trigger a local pack, so it's the wrong thing to
// put on a grid. The intent field exists so v1 competitor-mined keywords
// (which need classification + the SERP local-pack gate) slot in without a
// schema change.

export type LocalKeywordIntent = 'service' | 'commercial' | 'informational';

/** Intent → weight in the Priority score. Core service = the only kind
 *  worth a grid run; commercial/info kept for forward-compat scoring. */
const INTENT_SCORE: Record<LocalKeywordIntent, number> = {
  service: 1.0,
  commercial: 0.5,
  informational: 0.1,
};

export type LocalKeywordCandidate = {
  /** Display form: "{stem} {city}" (lowercased), or just the stem when no
   *  city is known. This is what gets tracked + put on the grid. */
  keyword: string;
  /** The underlying service stem (geo-independent). */
  stem: string;
  intent: LocalKeywordIntent;
  /** Whether the business category matched a known vertical (vs the
   *  literal-word fallback) — a confidence signal, not a gate. */
  categoryMatch: boolean;
  /** Internal ordering score — NOT TurfScore. Higher = better starter
   *  keyword. MVP inputs: intent + category match + the stem's curated
   *  rank (INDUSTRY_STEMS lists the headline service first). v1+ folds in
   *  competitor_ranked + metro volume. */
  priority: number;
};

/**
 * Rank grid-appropriate keyword candidates for a resolved business.
 * Returns highest-priority first; the caller auto-selects `[0]` for the
 * free scan and surfaces the rest as alternatives. Empty when no industry
 * is resolvable (caller falls back to the user-typed keyword field).
 */
export function rankLocalKeywordCandidates(
  industry: string | null,
  city: string | null,
  opts?: { limit?: number }
): LocalKeywordCandidate[] {
  const key = matchIndustryKey(industry);
  const stems = getKeywordStems(industry);
  if (stems.length === 0) return [];
  const categoryMatch = key !== null;
  const place = (city ?? '').trim();

  const candidates = stems.map((stem, i) => {
    // Curated-rank prior: INDUSTRY_STEMS lists the headline service first,
    // so earlier stems are stronger defaults. Normalized to (0,1].
    const stemPrior = (stems.length - i) / stems.length;
    const intent: LocalKeywordIntent = 'service';
    const priority =
      INTENT_SCORE[intent] + (categoryMatch ? 0.25 : 0) + stemPrior;
    const keyword = (place ? `${stem} ${place}` : stem)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return { keyword, stem, intent, categoryMatch, priority };
  });

  candidates.sort((a, b) => b.priority - a.priority);
  return typeof opts?.limit === 'number'
    ? candidates.slice(0, Math.max(0, opts.limit))
    : candidates;
}
