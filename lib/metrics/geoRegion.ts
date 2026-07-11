/**
 * US-state geo helpers for competitor geo-sanity filtering.
 *
 * Why this exists: when a scan keyword contains a city name that COLLIDES
 * with a more prominent same-name city elsewhere (e.g. "painter dayton" for
 * a client in Dayton, MN — dwarfed by Dayton, OH), Google's local pack
 * fills the slots the client doesn't already own with businesses from the
 * PROMINENT city. The scan is coordinate-anchored to the client's town so
 * the client still ranks #1 (an inflated, meaningless score), but the
 * "competitors" surfaced are out-of-state and must not reach a client
 * deliverable. See lib/metrics/competitors.ts + competitorIntel.ts for the
 * filter, and detectGeoAmbiguity for the keyword warning.
 *
 * The only geo signal DFS's organic-SERP local_pack carries is free text
 * (title + description, e.g. "Five Star Painting of Dayton, OH" / "· Dayton,
 * MN"), so detection is text-based: parse a US state and compare to the
 * client's known NAP region. Conservative by design — when no state is
 * detectable we DON'T filter (never drop a possibly-legit competitor).
 *
 * Pure, no I/O. Guarded by scripts/verify-geo-ambiguity.ts.
 */

const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
};

const VALID_ABBRS = new Set(Object.values(STATE_NAME_TO_ABBR));

/** Normalize a region string (full name or 2-letter code, any case) to its
 *  canonical USPS abbreviation, or null if it isn't a US state. */
export function normalizeUsState(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  if (s.length === 2) {
    const up = s.toUpperCase();
    return VALID_ABBRS.has(up) ? up : null;
  }
  return STATE_NAME_TO_ABBR[s.toLowerCase()] ?? null;
}

// Full state names longest-first, so "new york" wins before any substring.
const STATE_NAMES_BY_LENGTH = Object.keys(STATE_NAME_TO_ABBR).sort(
  (a, b) => b.length - a.length
);

/** Extract a US state from free text (a local-pack title or description),
 *  or null. Prefers the comma-delimited "City, ST" form (the reliable
 *  local-pack signal, e.g. "... of Dayton, OH"); falls back to a full state
 *  name appearing as a whole word. Returns the canonical abbreviation.
 *  Conservative: a bare 2-letter token only counts when comma-delimited, so
 *  "Fresh Coat Painters" can't false-match a state. */
export function usStateFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  // 1. Comma + 2-letter code ("City, ST") — take the LAST valid one, since
  //    the state trails the locality.
  let last: string | null = null;
  for (const m of text.matchAll(/,\s*([A-Za-z]{2})\b/g)) {
    const st = normalizeUsState(m[1]!);
    if (st) last = st;
  }
  if (last) return last;
  // 2. A full state name as a whole word (e.g. "Dayton, Ohio" or "serving
  //    all of Ohio"). Punctuation is flattened to spaces for word-boundary
  //    matching; longest names first so "new york" beats "york"-less noise.
  const flat = ` ${text.toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  for (const name of STATE_NAMES_BY_LENGTH) {
    if (flat.includes(` ${name} `)) return STATE_NAME_TO_ABBR[name]!;
  }
  return null;
}

/** Resolve a raw competitor's state: a stored `region` (populated on newer
 *  scans from title+description) takes precedence; otherwise parse the name
 *  (older scans only persisted the cleaned title, which usually retains the
 *  "..., OH" suffix when the business name carried it). */
export function competitorState(comp: {
  name?: string | null;
  region?: string | null;
}): string | null {
  return normalizeUsState(comp.region) ?? usStateFromText(comp.name);
}

/** True when `state` is a known US state that differs from the client's
 *  normalized region. Unknown/undetected states are NOT out-of-region (we
 *  never drop a competitor we can't place). */
export function isOutOfRegion(
  state: string | null,
  clientRegion: string | null
): boolean {
  const cr = normalizeUsState(clientRegion);
  if (!cr || !state) return false;
  return state !== cr;
}
