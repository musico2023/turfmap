/**
 * Guard: Keyword Opportunity Finder — cross-keyword ranking.
 */
import { rankKeywordOpportunities } from '../lib/metrics/keywordOpportunity';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// ── Cross-keyword ranking ───────────────────────────────────────────
const single = rankKeywordOpportunities([
  { keyword: 'only one', isPrimary: true, turfScore: 40, turfReach: 50, turfRank: 2 },
]);
check('single keyword → null (nothing to compare)', single === null);

const res = rankKeywordOpportunities([
  { keyword: 'won kw', isPrimary: false, turfScore: 80, turfReach: 75, turfRank: 2.7 },
  { keyword: 'push kw', isPrimary: true, turfScore: 45, turfReach: 45, turfRank: 2.1 },
  { keyword: 'build kw', isPrimary: false, turfScore: 12, turfReach: 8, turfRank: 1.2 },
  { keyword: 'noise kw', isPrimary: false, turfScore: 0, turfReach: 2, turfRank: null }, // <5% = no foothold
  { keyword: 'dead kw', isPrimary: false, turfScore: 0, turfReach: 0, turfRank: null },
]);
check('multi keyword → result', res !== null);
if (res) {
  check('top opportunity is the push keyword', res.topOpportunity?.keyword === 'push kw', res.topOpportunity?.keyword);
  check('won keyword classified defend', res.keywords.find((k) => k.keyword === 'won kw')?.tier === 'defend');
  check('push keyword classified push (15–60%)', res.keywords.find((k) => k.keyword === 'push kw')?.tier === 'push');
  check('build keyword classified build (5–15%)', res.keywords.find((k) => k.keyword === 'build kw')?.tier === 'build');
  check('2%-reach keyword is reconsider, not build', res.keywords.find((k) => k.keyword === 'noise kw')?.tier === 'reconsider');
  check('dead keyword classified reconsider', res.keywords.find((k) => k.keyword === 'dead kw')?.tier === 'reconsider');
  check('dead list contains both sub-5% keywords', res.dead.includes('dead kw') && res.dead.includes('noise kw'));
  check('push sorted ahead of defend', res.keywords[0].keyword === 'push kw', res.keywords[0].keyword);
  check('headline names the focus keyword', /push kw/.test(res.headline), res.headline);
}

// No-push case (Logik-like: 2 winning, 2 stuck, nothing in the push band).
// top opportunity must be null — we don't promote a near-zero keyword.
const noPush = rankKeywordOpportunities([
  { keyword: 'insulation oshawa', isPrimary: true, turfScore: 60, turfReach: 100, turfRank: 2.5 },
  { keyword: 'roofing oshawa', isPrimary: false, turfScore: 45, turfReach: 79, turfRank: 2.2 },
  { keyword: 'insulation toronto', isPrimary: false, turfScore: 0, turfReach: 1, turfRank: null },
  { keyword: 'mold remediation', isPrimary: false, turfScore: 0, turfReach: 0, turfRank: null },
]);
check('no-push → null top opportunity (no near-zero promotion)', noPush?.topOpportunity == null);
check('no-push headline holds winners + reworks stuck',
  /hold your 2 winning/i.test(noPush?.headline ?? '') && /rework 2/.test(noPush?.headline ?? ''),
  noPush?.headline);

// All-won → defend headline, no opportunity.
const allWon = rankKeywordOpportunities([
  { keyword: 'a', isPrimary: true, turfScore: 90, turfReach: 80, turfRank: 2.8 },
  { keyword: 'b', isPrimary: false, turfScore: 85, turfReach: 70, turfRank: 2.6 },
]);
check('all-won → no top opportunity', allWon?.topOpportunity == null);
check('all-won headline mentions winning', /winning every tracked keyword/.test(allWon?.headline ?? ''), allWon?.headline);

if (failures > 0) { console.error(`\nverify-keyword-opportunity: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-keyword-opportunity: all checks passed');
