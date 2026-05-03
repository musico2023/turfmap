/**
 * Address normalization for the NAP audit matcher.
 *
 * Without this, the matcher flags noise like:
 *   - "240 Duncan Mill Rd" vs "240 Duncan Mill Road"
 *   - "Toronto, ON" vs "Toronto, Ontario"
 *   - "Main St N" vs "Main Street North"
 *
 * Real directories present these formatting variants constantly. None
 * of them represent actual NAP inconsistencies — they're equivalent
 * spellings of the same address — but the matcher previously treated
 * each as a real mismatch and the AI Coach surfaced them as fixable
 * problems. Anthony hit this on Don Mills with "Rd / North York / ON"
 * vs the canonical "Road / Toronto / Ontario" being flagged HIGH.
 *
 * Approach: token-level expansion of common street suffixes, cardinal
 * directions, and state/province codes to their long forms before
 * comparison. Both sides of the matcher run through the same
 * normalization, so the comparison is symmetric.
 *
 * What this does NOT normalize away:
 *   - Borough vs city semantics ("North York" vs "Toronto") — a real
 *     judgement call the operator should make
 *   - Genuinely different street numbers (1440 vs 1430)
 *   - Genuinely different postcodes
 *   - Saint-prefixed cities ("St. Catharines") may misnormalize to
 *     "street catharines" but symmetrically on both sides; net effect
 *     on equality is nil
 */

/**
 * Token-level abbreviation → expanded form. Conservative set: only
 * unambiguous mappings that don't conflict with state codes or other
 * common-word collisions. "ct" deliberately omitted since it's both
 * "Court" and "Connecticut".
 */
const ABBREV_TO_FULL: Record<string, string> = {
  // Street suffixes
  rd: 'road',
  st: 'street', // St-prefixed cities will misnormalize but symmetrically
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  dr: 'drive',
  ln: 'lane',
  pl: 'place',
  hwy: 'highway',
  pkwy: 'parkway',
  ter: 'terrace',
  cir: 'circle',
  sq: 'square',
  trl: 'trail',
  way: 'way',

  // Cardinal directions (when used as suffixes/prefixes in addresses)
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',

  // Canadian provinces (no conflicts with street suffixes)
  ab: 'alberta',
  bc: 'british columbia',
  mb: 'manitoba',
  nb: 'new brunswick',
  nl: 'newfoundland and labrador',
  ns: 'nova scotia',
  nt: 'northwest territories',
  nu: 'nunavut',
  on: 'ontario',
  pe: 'prince edward island',
  qc: 'quebec',
  sk: 'saskatchewan',
  yt: 'yukon',

  // US states (skipping 'ct' = Connecticut, which conflicts with Court)
  al: 'alabama',
  ak: 'alaska',
  az: 'arizona',
  ar: 'arkansas',
  ca: 'california',
  co: 'colorado',
  de: 'delaware',
  fl: 'florida',
  ga: 'georgia',
  hi: 'hawaii',
  id: 'idaho',
  il: 'illinois',
  in: 'indiana',
  ia: 'iowa',
  ks: 'kansas',
  ky: 'kentucky',
  la: 'louisiana',
  me: 'maine',
  md: 'maryland',
  ma: 'massachusetts',
  mi: 'michigan',
  mn: 'minnesota',
  ms: 'mississippi',
  mo: 'missouri',
  mt: 'montana',
  // 'ne' is intentionally OMITTED — collides with the cardinal direction
  // 'northeast'. Addresses use NE for direction far more often than for
  // Nebraska; treating it as direction symmetrically produces correct
  // matches in both contexts (a Nebraska address normalizes to "...
  // lincoln northeast 68508" on both sides → still matches).
  nv: 'nevada',
  nh: 'new hampshire',
  nj: 'new jersey',
  nm: 'new mexico',
  ny: 'new york',
  nc: 'north carolina',
  nd: 'north dakota',
  oh: 'ohio',
  ok: 'oklahoma',
  or: 'oregon',
  pa: 'pennsylvania',
  ri: 'rhode island',
  sc: 'south carolina',
  sd: 'south dakota',
  tn: 'tennessee',
  tx: 'texas',
  ut: 'utah',
  vt: 'vermont',
  va: 'virginia',
  wa: 'washington',
  wv: 'west virginia',
  wi: 'wisconsin',
  wy: 'wyoming',
};

/**
 * Lower-case, strip non-alphanumeric, collapse whitespace, and expand
 * known abbreviations. Used by the NAP matcher's equality + fuzzy
 * comparison; both sides run through this so symmetry is preserved.
 */
export function normalizeAddress(s: string | null | undefined): string {
  const cleaned = (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ');
  const expanded = tokens.map((t) => ABBREV_TO_FULL[t] ?? t);
  return expanded.join(' ');
}
