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

export function getKeywordStems(industry: string | null): string[] {
  if (!industry || industry.trim().length === 0) return [];
  const trimmed = industry.trim();
  for (const rule of INDUSTRY_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return INDUSTRY_STEMS[rule.key] ?? [];
    }
  }
  // No pattern matched — fall back to the literal industry word as a
  // single stem so suggestions still surface for novel verticals.
  return [trimmed.toLowerCase()];
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
