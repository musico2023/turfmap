/**
 * Guard: industry taxonomy coverage — the "never run into this again"
 * gate (2026-07-22, after a moving company had no industry anywhere).
 *
 * Four layers must stay in sync: the picker options
 * (lib/industries/options.ts), the keyword resolver
 * (matchIndustryKey in lib/keywords/suggestions.ts), the GBP
 * primaryType map (lib/google/primaryTypeToIndustry.ts), and the
 * curated GBP category list (lib/citations/gbp-categories.ts).
 *
 * Asserts:
 *   1. Every picker option resolves to keyword stems.
 *   2. Every GBP category resolves too — or is consciously listed in
 *      DELIBERATELY_UNMAPPED below (retail/civic categories where the
 *      literal-word fallback suggestion is the right behavior). Adding
 *      a new GBP category without deciding its mapping FAILS THE BUILD.
 *   3. Spot-checks: the moving vertical end-to-end + earlier incident
 *      categories keep resolving to the right keys.
 */

import { matchIndustryKey, getKeywordStems } from '../lib/keywords/suggestions';
import { INDUSTRY_GROUPS } from '../lib/industries/options';
import { GBP_CATEGORIES } from '../lib/citations/gbp-categories';

/** GBP categories with NO industry key ON PURPOSE. These are retail /
 *  civic / venue categories where per-vertical keyword stems add
 *  nothing — the literal-fallback suggestion ("florist glendale"-style,
 *  from the category name itself) is already the right keyword shape,
 *  and none are plausible Local Lead Machine clients. Review before
 *  adding here: if a category could become a client vertical, give it
 *  stems + a pattern instead. */
const DELIBERATELY_UNMAPPED = new Set<string>([
  // Retail & shopping — literal fallback is the right keyword
  'Water filter supplier',
  'Water softening equipment supplier',
  'Hot water system supplier',
  'Generator shop',
  'Patio enclosure supplier',
  'Clothing store',
  "Women's clothing store",
  "Men's clothing store",
  "Children's clothing store",
  'Shoe store',
  'Jewelry store',
  'Watch store',
  'Sunglasses store',
  'Bookstore',
  'Toy store',
  'Hobby store',
  'Sporting goods store',
  'Bicycle store',
  'Outdoor sports store',
  'Furniture store',
  'Home goods store',
  'Hardware store',
  'Gift shop',
  'Antique store',
  'Thrift store',
  'Pawn shop',
  'Convenience store',
  'Department store',
  'Shopping mall',
  'Mattress store',
  'Electronics store',
  'Computer store',
  'Cell phone store',
  'Cosmetics store',
  'Beauty supply store',
  'Health food store',
  'Vitamin & supplements store',
  'Grocery store',
  'Butcher shop',
  'Wine store',
  'Liquor store',
  // Professional/other where we deliberately have no stems yet
  'Business management consultant',
  'Marketing consultant',
  'Marketing agency',
  'Advertising agency',
  'Internet marketing service',
  'Web designer',
  'Software company',
  'Financial planner',
  'Financial consultant',
  'Translator',
  'Architect',
  'Interior designer',
  'Engineering consultant',
  'Surveyor',
  'Graphic designer',
  // Education venues without stems
  'School',
  'Language school',
  'Art school',
  // Entertainment venues
  'Live music venue',
  'Bowling alley',
  'Movie theater',
  'Escape room center',
  // Travel
  'Travel agency',
  'Tour operator',
  // Civic / misc
  'Church',
  'Place of worship',
  'Non-profit organization',
  'Community center',
  'Recycling center',
  'Print shop',
  'Sign shop',
  'Shipping and mailing service',
  'Post office',
  'Bank',
  'Credit union',
  'ATM',
]);

let failures = 0;
function fail(msg: string) {
  failures++;
  console.error(`✗ ${msg}`);
}

// ── 1. Every picker option resolves ─────────────────────────────────
let optionCount = 0;
for (const group of INDUSTRY_GROUPS) {
  for (const option of group.options) {
    optionCount++;
    const key = matchIndustryKey(option);
    if (!key) fail(`picker option "${option}" (${group.label}) resolves to NO industry key`);
    else if ((getKeywordStems(option) ?? []).length === 0)
      fail(`picker option "${option}" resolved to key "${key}" but has no stems`);
  }
}
console.log(`✓ ${optionCount} picker options checked`);

// ── 2. Every GBP category resolves or is consciously unmapped ───────
let mapped = 0;
let unmappedOk = 0;
for (const cat of GBP_CATEGORIES) {
  const key = matchIndustryKey(cat);
  if (key) {
    mapped++;
    if (DELIBERATELY_UNMAPPED.has(cat)) {
      fail(`GBP category "${cat}" resolves to "${key}" but is ALSO in DELIBERATELY_UNMAPPED — remove it from the list`);
    }
  } else if (DELIBERATELY_UNMAPPED.has(cat)) {
    unmappedOk++;
  } else {
    fail(`GBP category "${cat}" resolves to NO industry key and is not in DELIBERATELY_UNMAPPED — add stems+pattern or consciously exempt it`);
  }
}
console.log(`✓ GBP categories: ${mapped} mapped, ${unmappedOk} deliberately unmapped, ${GBP_CATEGORIES.length} total`);

// ── 3. Spot-checks: incident categories resolve to the RIGHT key ────
const expect: Array<[string, string]> = [
  ['Moving company', 'moving'],           // 2026-07-22 incident
  ['moving_company', 'moving'],           // raw GBP primaryType string
  ['Junk removal service', 'junkremoval'],
  ['Self-storage facility', 'storage'],
  ['Dessert shop', 'dessert'],            // D Spot class
  ['kitchen remodeling', 'remodeling'],   // Payless class
  ['Gutter cleaning service', 'gutters'],
  ['Window cleaning service', 'windowcleaning'],
  ['Window installation service', 'windowsdoors'],
  ['Garage door supplier', 'garagedoor'],
  ['Dog day care center', 'petcare'],     // must NOT hit childcare
  ['Day care center', 'childcare'],
  ['Barber shop', 'barber'],              // must NOT hit 'bar'
  ['Snow removal service', 'snowremoval'],// \bmov must not catch "removal"
  ['Movie theater', null as unknown as string], // \bmov(er|ing) must not catch "movie"
  ['Tax attorney', 'legal'],              // legal outranks accounting
  ['Towing service', 'towing'],
  ['Massage therapist', 'massage'],
  ['Painter', 'painting'],
];
for (const [input, want] of expect) {
  const got = matchIndustryKey(input);
  const wantVal = want ?? null;
  if (got !== wantVal) fail(`spot-check "${input}" → got "${got}", want "${wantVal}"`);
}
console.log(`✓ ${expect.length} spot-checks run`);

if (failures > 0) {
  console.error(`\nverify-industry-coverage: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-industry-coverage: all checks passed');
