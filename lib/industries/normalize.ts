/**
 * Industry normalisation — stops a business NAME being stored as a TRADE.
 *
 * Why this exists: `clients.industry` is free text (z.string().max(80)), and
 * the outreach scripts had no trade field on their target rows, so they wrote
 * the brand: `industry: t.brand` (outreach-c2-apex-guardian-scan.ts) and
 * `industry: loc.brand` (outreach-c2-portfolio-scan.ts). That produced 134
 * clients whose industry was "Allbritten", "AB May", "Victors Home
 * Solutions"… (2026-08-27 and 2026-09-01 batches).
 *
 * The damage is silent and downstream: `industry` is half of the TradeContext
 * that drives lib/metrics/tradeRelevance.ts (out-of-trade competitor
 * filtering) and the AI Coach's prompt (lib/ai-coach/generateInsight.ts).
 * A brand-as-trade means the collision rules never fire and the Coach reasons
 * about a business whose trade it thinks is "Allbritten".
 *
 * Conservative, same contract as its siblings in lib/metrics: a value is only
 * rejected when it is unambiguously a brand — it appears inside the business
 * name AND no known trade pattern matches it. "Painting Plus" tagged
 * 'painting' is kept, because 'painting' resolves to a real trade key.
 *
 * Pure, no I/O. Guarded by scripts/verify-industry-normalize.ts.
 */

import { matchIndustryKey } from '@/lib/keywords/suggestions';

/** Generic head-nouns that carry no trade meaning once stripped from a
 *  scanned keyword ("hvac company near me" → "hvac"). Order matters: the
 *  longest suffix is removed first. */
const KEYWORD_SUFFIXES = [
  ' near me',
  ' company',
  ' contractor',
  ' services',
  ' service',
];

function clean(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Comparison form: punctuation folded to spaces so brand variants line up.
 *  "ab may" vs "A.B. May Heating, A/C…" and "blue ox heating air" vs "Blue Ox
 *  Heating & Air" both failed a raw substring test — 16 rows of the
 *  2026-08-27 batch survived the first backfill pass as lowercased brands
 *  because of exactly this. */
function compareKey(value: string | null | undefined): string {
  return clean(value).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** Fully collapsed form — no separators at all. Needed because folding
 *  punctuation to spaces turns "A.B." into "a b", which does not contain
 *  "ab may". Only consulted for values long enough that an accidental
 *  substring hit is implausible. */
function collapsedKey(value: string | null | undefined): string {
  return clean(value).replace(/[^a-z0-9]+/g, '');
}

const MIN_COLLAPSED_LEN = 4;

/** Strip " near me" and generic head-nouns off a scanned keyword. */
export function tradeFromKeyword(keyword: string | null | undefined): string | null {
  let out = clean(keyword);
  if (!out) return null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of KEYWORD_SUFFIXES) {
      if (out.endsWith(suffix) && out.length > suffix.length) {
        out = out.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
  }
  return out || null;
}

/**
 * True when `value` is the business's own name (or a fragment of it) rather
 * than a trade. Requires BOTH signals — inside the name, and unrecognised as
 * a trade — so legitimate overlaps survive.
 */
export function isBrandLeakage(
  value: string | null | undefined,
  businessName: string | null | undefined
): boolean {
  const v = compareKey(value);
  const name = compareKey(businessName);
  if (!v || !name) return false;
  const cv = collapsedKey(value);
  const cn = collapsedKey(businessName);
  const contained =
    name.includes(v) ||
    (cv.length >= MIN_COLLAPSED_LEN && cn.includes(cv));
  if (!contained) return false;
  // A value identical to the whole business name is the name, full stop —
  // even when the brand embeds its trade ("DryLux Restoration", "Rogers
  // Roofing"). Without this, matchIndustryKey sees the trade word and waves
  // the brand through, which is how half the 2026-08-27 batch would survive.
  if (v === name || (cv.length >= MIN_COLLAPSED_LEN && cv === cn)) return true;
  return matchIndustryKey(v) === null;
}

/**
 * Resolve the industry to store for a client.
 *
 * Precedence: an explicit, non-brand value wins; otherwise fall back to the
 * trade implied by the scanned keyword; otherwise null. Never returns a
 * brand name, and never returns a non-lowercase value.
 */
export function normalizeIndustry(
  raw: string | null | undefined,
  ctx: { businessName?: string | null; keyword?: string | null } = {}
): string | null {
  const candidate = tradeFromKeyword(raw) ?? clean(raw) ?? null;
  if (candidate && !isBrandLeakage(candidate, ctx.businessName)) {
    return candidate;
  }
  // Explicit value was a brand (or absent) — derive from the keyword, which
  // is what the operator actually scanned for.
  const derived = tradeFromKeyword(ctx.keyword);
  if (derived && !isBrandLeakage(derived, ctx.businessName)) return derived;
  return null;
}
