/**
 * Guard: Keyword Opportunity Finder — striking distance + cross-keyword ranking.
 */
import { strikingDistance } from '../lib/metrics/strikingDistance';
import { rankKeywordOpportunities } from '../lib/metrics/keywordOpportunity';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// ── Striking distance ───────────────────────────────────────────────
// 10-cell grid: 2 in-pack (1,3), 3 striking (4,5,6 → all near-pack),
// 1 striking-not-near (8), 1 out (15), rest absent (null).
const sd = strikingDistance([1, 3, 4, 5, 6, 8, 15, null, null, null], 10);
check('in-pack counted (rank ≤3)', sd.inPack === 2, `got ${sd.inPack}`);
check('striking = rank 4–10 (4,5,6,8)', sd.striking === 4, `got ${sd.striking}`);
check('near-pack = rank 4–6 (4,5,6)', sd.nearPack === 3, `got ${sd.nearPack}`);
check('rank 15 excluded from striking', sd.striking === 4);
check('strikingPct over full grid (4/10)', sd.strikingPct === 40, `got ${sd.strikingPct}`);
check('nearPackPct over full grid (3/10)', sd.nearPackPct === 30, `got ${sd.nearPackPct}`);

// ── Cross-keyword ranking ───────────────────────────────────────────
const single = rankKeywordOpportunities([
  { keyword: 'only one', isPrimary: true, turfScore: 40, turfReach: 50, turfRank: 2 },
]);
check('single keyword → null (nothing to compare)', single === null);

const res = rankKeywordOpportunities([
  { keyword: 'won kw', isPrimary: false, turfScore: 80, turfReach: 75, turfRank: 2.7 },
  { keyword: 'push kw', isPrimary: true, turfScore: 45, turfReach: 45, turfRank: 2.1 },
  { keyword: 'build kw', isPrimary: false, turfScore: 12, turfReach: 8, turfRank: 1.2 },
  { keyword: 'dead kw', isPrimary: false, turfScore: 0, turfReach: 0, turfRank: null },
]);
check('multi keyword → result', res !== null);
if (res) {
  check('top opportunity is the push keyword', res.topOpportunity?.keyword === 'push kw', res.topOpportunity?.keyword);
  check('won keyword classified defend', res.keywords.find((k) => k.keyword === 'won kw')?.tier === 'defend');
  check('push keyword classified push', res.keywords.find((k) => k.keyword === 'push kw')?.tier === 'push');
  check('build keyword classified build', res.keywords.find((k) => k.keyword === 'build kw')?.tier === 'build');
  check('dead keyword classified reconsider', res.keywords.find((k) => k.keyword === 'dead kw')?.tier === 'reconsider');
  check('dead list contains the zero-reach keyword', res.dead.includes('dead kw'));
  check('push sorted ahead of defend', res.keywords[0].keyword === 'push kw', res.keywords[0].keyword);
  check('headline names the focus keyword', /push kw/.test(res.headline), res.headline);
}

// All-won → defend headline, no opportunity.
const allWon = rankKeywordOpportunities([
  { keyword: 'a', isPrimary: true, turfScore: 90, turfReach: 80, turfRank: 2.8 },
  { keyword: 'b', isPrimary: false, turfScore: 85, turfReach: 70, turfRank: 2.6 },
]);
check('all-won → no top opportunity', allWon?.topOpportunity == null);
check('all-won headline mentions winning', /winning every tracked keyword/.test(allWon?.headline ?? ''), allWon?.headline);

if (failures > 0) { console.error(`\nverify-keyword-opportunity: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-keyword-opportunity: all checks passed');
