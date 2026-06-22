/**
 * NAP comparison utilities for citation checking.
 *
 * Used by the DFS citation checker to decide whether a found listing's
 * NAP matches the canonical business profile, mismatches, or is too
 * incomplete to tell.
 *
 * Why a dedicated module: every directory returns NAP fields in
 * slightly different shapes — Yelp gives a clean structured address,
 * BBB embeds it in a snippet, Apple Maps redacts city/region, etc.
 * The classifier needs to be tolerant of formatting variance without
 * silently passing a "mismatch" as "matched" (the worst false negative).
 *
 * Comparison rules (in order of strictness):
 *   1. Normalize: strip whitespace, lowercase, drop punctuation
 *   2. Phone: compare last-10-digits (handles "+1-416-..." vs "(416)...")
 *   3. Address: substring containment with street-number priority
 *   4. Name: token-set similarity (handles "Sugar Daddy Doughnuts" vs
 *      "Sugar Daddy Doughnuts Inc.")
 *
 * NEVER throws — every helper returns false on bad input rather than
 * crashing the audit. A citation check is "best effort" — a single bad
 * snippet shouldn't fail the whole audit.
 */

/** Strip whitespace, lowercase, drop common business-suffix noise. */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|company|co|the)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reduce a phone string to last-10-digits. Returns '' on bad input. */
export function normalizePhone(s: string | null | undefined): string {
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  // Strip leading country code if present (assume 1+10 for US/CAN).
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Lowercase + collapse whitespace. Strip punctuation to neutralize
 *  comma/period variants ("Toronto, ON" vs "Toronto ON"). */
export function normalizeAddress(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-set similarity in [0,1]: |A∩B| / |A∪B|. */
function tokenSetSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = new Set(a.split(/\s+/).filter(Boolean));
  const B = new Set(b.split(/\s+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return inter / union;
}

/** Name match uses CONTAINMENT, not Jaccard. The canonical name's
 *  token set must be ≥75% present in the found name's token set.
 *
 *  Why containment beat Jaccard here: Jaccard penalizes "extra" tokens
 *  in either string equally. But directory listings routinely include
 *  qualifiers in their titles ("BVM Contracting | Toronto ON",
 *  "Profile of Bvm Contracting in Scarborough"). With Jaccard, those
 *  legit matches scored 0.5 vs canonical "BVM Contracting" and got
 *  rejected. With containment, all-of-canonical-in-found suffices.
 *
 *  Threshold 0.75 chosen so:
 *    - 2-token canonicals require both tokens present (2/2 = 100%)
 *    - 3-token canonicals tolerate one missing token (2/3 = 67% fails,
 *      3/3 = 100% passes)
 *    - 4+ token canonicals tolerate light pluralization variance
 *      (4/5 = 80% passes; "Honest Plumber & Drain Co" matches "Honest
 *       Plumbers Drain").
 *
 *  Generic connector tokens are dropped before scoring so the 0.75 bar is
 *  measured against DISTINCTIVE tokens only. Without this, a long legal
 *  name like "CertaPro Painters OF Calgary AND Central Alberta" (7 tokens,
 *  2 of them filler) couldn't clear the bar against a directory's
 *  shortened title ("CertaPro Painters … Calgary, Alberta … Yelp") and the
 *  real listing was falsely reported "missing". This does NOT weaken
 *  franchise protection: dropping "of/and" leaves the location tokens
 *  (calgary/central/alberta) in the denominator, so a sibling franchise
 *  ("…of Edmonton", "…of Southern Alberta") still fails on the mismatched
 *  city. */
const NAME_FILLER = new Set([
  'of', 'and', 'the', 'at', 'for', 'to', 'in', 'on', 'a', 'an',
]);

export function nameMatches(
  canonical: string | null | undefined,
  found: string | null | undefined
): boolean {
  const rawA = normalizeName(canonical).split(/\s+/).filter(Boolean);
  const rawB = normalizeName(found).split(/\s+/).filter(Boolean);
  // Strip generic connectors so a long legal name still matches a short
  // directory title — UNLESS stripping collapses the canonical below 2
  // distinctive tokens (a load-bearing stopword like "On Point" → "point"
  // would otherwise match any "...point..." listing). In that case keep
  // the unstripped tokens so the bar stays meaningful.
  const strippedA = rawA.filter((t) => !NAME_FILLER.has(t));
  // Require ≥3 distinctive tokens to apply stripping: a 2-token canonical
  // like "On Point Plumbing" (strips to ['point','plumbing']) still has a
  // common-word overlap risk with unrelated businesses that share those two
  // tokens, so we keep the full rawA (including load-bearing fillers) to
  // make the bar harder to clear.
  const useStripped = strippedA.length >= 3;
  const a = useStripped ? strippedA : rawA;
  const b = new Set(useStripped ? rawB.filter((t) => !NAME_FILLER.has(t)) : rawB);
  if (a.length === 0 || b.size === 0) return false;
  const matched = a.filter((t) => b.has(t)).length;
  // When canonical is very short (1 raw token after normalization), forward
  // containment alone is too weak — any listing that includes that one token
  // would pass. Require bidirectional ≥0.75 so "The Inn" doesn't match
  // "Inn at the Lake" (backward score = 1/3 = 0.33 → rejected).
  if (a.length === 1) {
    return matched / a.length >= 0.75 && matched / b.size >= 0.75;
  }
  return matched / a.length >= 0.75;
}

/** Phones match iff last-10-digits are identical AND non-empty. */
export function phoneMatches(
  canonical: string | null | undefined,
  found: string | null | undefined
): boolean {
  const a = normalizePhone(canonical);
  const b = normalizePhone(found);
  if (a.length < 10 || b.length < 10) return false;
  return a === b;
}

/** Address matches when normalized strings share the street-number token
 *  (e.g., "80") AND ≥0.5 token-set similarity. Street number is the
 *  highest-signal token — two listings sharing it are very likely the
 *  same physical address. */
export function addressMatches(
  canonical: string | null | undefined,
  found: string | null | undefined
): boolean {
  const a = normalizeAddress(canonical);
  const b = normalizeAddress(found);
  if (!a || !b) return false;
  // Pull street numbers (run of digits at the start of a token).
  const streetNumRegex = /\b(\d{1,6})\b/;
  const numA = a.match(streetNumRegex)?.[1] ?? null;
  const numB = b.match(streetNumRegex)?.[1] ?? null;
  if (!numA || !numB || numA !== numB) return false;
  return tokenSetSimilarity(a, b) >= 0.5;
}

/** Citation classification result. Mirrors the NapAuditCitation status
 *  field so the upstream `summarizeFindings` shape is unchanged. */
export type CitationStatus = 'matched' | 'mismatch' | 'unverified';

/** Given canonical NAP + found NAP from a directory, classify match.
 *
 *   matched      — name AND (phone OR address) match
 *   mismatch     — name matches BUT phone+address both differ (real
 *                  inconsistency the operator should fix)
 *   unverified   — name doesn't match clearly OR fields are missing
 *                  (don't claim a mismatch we can't substantiate)
 *
 * Note: phone OR address suffices for "matched" because some directories
 * (Apple Maps, Foursquare) hide phone numbers, while others (Yelp's
 * snippet truncations) hide street numbers. Requiring BOTH would
 * under-report matches.
 */
export function classifyCitation(
  canonical: {
    name: string;
    phone: string | null | undefined;
    address: string | null | undefined;
  },
  found: {
    name: string | null;
    phone: string | null;
    address: string | null;
  }
): CitationStatus {
  if (!nameMatches(canonical.name, found.name)) {
    return 'unverified';
  }
  const phoneOk = phoneMatches(canonical.phone, found.phone);
  const addressOk = addressMatches(canonical.address, found.address);
  if (phoneOk || addressOk) return 'matched';
  // Name matched but neither phone nor address — could be either:
  //   - listing has stale NAP (real mismatch worth surfacing)
  //   - or directory's snippet just doesn't show those fields
  // Without a second signal we don't have enough to flag — defer to
  // 'unverified' rather than over-promise a mismatch.
  if (
    (found.phone && !phoneOk) ||
    (found.address && !addressOk)
  ) {
    return 'mismatch';
  }
  return 'unverified';
}
