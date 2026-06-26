/**
 * Guard: competitor-reveal pure logic — top-competitor pick + the
 * candidate↔competitor-keyword intersection.
 */
import {
  pickTopCompetitor,
  markCompetitorRanked,
} from '../lib/keywords/competitorReveal';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// ── pickTopCompetitor ──
// 10 cells. "Acme" holds the pack widely (has a domain); "NoDomain" holds
// share but exposes no domain (can't mine → excluded). Own brand excluded.
const points = Array.from({ length: 10 }, (_, i) => ({
  rank: 2,
  competitors: [
    { name: 'Acme Roofing', domain: 'acmeroofing.com', rank_group: 1 },
    ...(i < 8 ? [{ name: 'NoDomain Co', domain: null, rank_group: 2 }] : []),
    { name: 'Bob Roofing Downtown', domain: 'bob.com', rank_group: 3 }, // own variant
  ],
}));

const top = pickTopCompetitor(points, 'Bob Roofing', 10);
check('returns a top competitor', top !== null);
check('top is the domain-bearing leader (Acme)', top?.name === 'Acme Roofing', top?.name);
check('top carries a cleaned domain', top?.domain === 'acmeroofing.com', top?.domain);
check('top share computed (10/10)', top?.sharePct === 100, String(top?.sharePct));
check('own-brand variant excluded', top?.name !== 'Bob Roofing Downtown');
check('domain-less competitor not chosen even with share',
  top?.name !== 'NoDomain Co');

// www / protocol / path are stripped.
const dirty = pickTopCompetitor(
  Array.from({ length: 6 }, () => ({
    rank: null,
    competitors: [{ name: 'Zeta', domain: 'https://www.zeta.com/contact', rank_group: 1 }],
  })),
  'Someone',
  6
);
check('domain normalized (protocol/www/path stripped)', dirty?.domain === 'zeta.com', dirty?.domain);

// No competitor with a domain → null.
const none = pickTopCompetitor(
  [{ rank: 1, competitors: [{ name: 'X', domain: null, rank_group: 1 }] }],
  'Me',
  1
);
check('no domain-bearing competitor → null', none === null);

// ── markCompetitorRanked ──
const stems = ['roofer', 'roof repair', 'roof replacement', 'insulation removal'];
const competitorKws = [
  'emergency roof repair toronto',
  'roofer near me',
  'metal roof replacement cost',
];
const matched = markCompetitorRanked(stems, competitorKws);
check('stem matches when contained in a competitor keyword (roof repair)', matched.has('roof repair'));
check('stem matches (roofer)', matched.has('roofer'));
check('stem matches (roof replacement)', matched.has('roof replacement'));
check('unmatched stem is not flagged (insulation removal)', !matched.has('insulation removal'));

if (failures > 0) { console.error(`\nverify-competitor-reveal: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-competitor-reveal: all checks passed');
