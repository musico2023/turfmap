/**
 * Guard: out-of-trade competitor filtering (lib/metrics/tradeRelevance).
 *
 * The filter is deliberately narrow — a dropped competitor is one the
 * client never learns about — so these cases pin BOTH directions: the
 * automotive shops that must go, and the residential glass companies
 * that must stay.
 */
import { isOutOfTrade } from '../lib/metrics/tradeRelevance';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// The client that prompted this: residential windows, "window replacement".
const windows = { industry: 'windows & doors', keyword: 'window replacement' };

// ── Must be filtered ────────────────────────────────────────────────────
for (const name of [
  'Shield Auto Glass',
  'Evergreen Auto Glass',
  'Portland Windshield Repair',
  'AutoGlass Now',
  'Precision Auto Body',
  'Westside Collision Center',
  'Elite Window Tinting',
]) {
  check(`filtered: ${name}`, isOutOfTrade(name, windows) === true);
}

// ── Must be kept ────────────────────────────────────────────────────────
// Real competitors from the Clear Choice scan. "Glass" on its own is a
// residential signal at least as often as an automotive one.
for (const name of [
  'Zen Windows Portland',
  'Renewal by Andersen of Portland',
  'All Season Windows, Siding & Roofing',
  'The Glass People',
  'All Oregon Glass',
  'Dr Glassman Repair',
  'Window Nation',
  'DaBella',
  'SFW Construction',
  'The Sashwright Co.',
]) {
  check(`kept: ${name}`, isOutOfTrade(name, windows) === false);
}

// ── The client is themselves automotive → keep automotive rivals ────────
const autoGlass = { industry: 'auto glass', keyword: 'windshield replacement' };
check('auto-glass client keeps auto-glass rivals',
  isOutOfTrade('Shield Auto Glass', autoGlass) === false);
check('auto-glass client keeps windshield rivals',
  isOutOfTrade('Portland Windshield Repair', autoGlass) === false);

// ── Unrelated trades are never touched ──────────────────────────────────
const roofing = { industry: 'roofing_contractor', keyword: 'roof repair' };
check('roofing client: auto glass not filtered (rule does not apply)',
  isOutOfTrade('Shield Auto Glass', roofing) === false);
const restaurant = { industry: 'restaurant', keyword: 'best tacos' };
check('restaurant client: nothing filtered',
  isOutOfTrade('Evergreen Auto Glass', restaurant) === false);

// ── Missing / partial context must never filter ─────────────────────────
check('no context → keep', isOutOfTrade('Shield Auto Glass', null) === false);
check('empty context → keep', isOutOfTrade('Shield Auto Glass', {}) === false);
check('empty name → keep', isOutOfTrade('', windows) === false);
check('null name → keep', isOutOfTrade(null, windows) === false);
check('keyword alone is enough context',
  isOutOfTrade('Shield Auto Glass', { keyword: 'window replacement' }) === true);
check('industry alone is enough context',
  isOutOfTrade('Shield Auto Glass', { industry: 'windows & doors' }) === true);

// ── Substring safety ────────────────────────────────────────────────────
// Word-boundary anchored: a name that merely CONTAINS these letters must
// not trip the filter.
check('"Autumn Glass Works" is not auto glass',
  isOutOfTrade('Autumn Glass Works', windows) === false);
check('"Carriage House Doors" is not car glass',
  isOutOfTrade('Carriage House Doors', windows) === false);

if (failures > 0) {
  console.error(`\nverify-trade-relevance: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-trade-relevance: all checks passed');
