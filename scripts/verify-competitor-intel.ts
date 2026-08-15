/**
 * Guard: Competitor Intel aggregation + client-vs-competitor deltas.
 */
import { computeCompetitorIntel } from '../lib/metrics/competitorIntel';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// Build a 30-cell grid. "Acme" dominates the pack; client appears in 9 cells.
// Competitor carries rating/reviews on its richest snapshot. A one-off brand
// (1/30 = 3.3%, below the 5% floor) must be filtered out.
const points = Array.from({ length: 30 }, (_, i) => ({
  rank: i < 9 ? 2 : null, // client in pack in 9/30 cells → 30% share
  competitors: [
    {
      name: 'Acme Plumbing',
      rank_group: 1,
      rating: 4.8,
      reviews: i === 0 ? 2400 : 30, // highest-review snapshot = 2400 @4.8
    },
    // a noise brand in just 1 cell (3.3% < MIN_SHARE_PCT) — should drop
    ...(i === 5 ? [{ name: 'One Off LLC', rank_group: 3, rating: 4.0, reviews: 5 }] : []),
  ],
}));

const res = computeCompetitorIntel({
  points,
  own: { name: 'Bob Plumbing', rating: 4.5, reviews: 100 },
  totalCells: 30,
});

check('returns a result when competitors present', res !== null);
if (res) {
  check('own share computed (9/30 = 30%)', res.own.sharePct === 30, `got ${res.own.sharePct}`);
  check('leader is Acme', res.leader?.name === 'Acme Plumbing', res.leader?.name);
  const acme = res.competitors.find((c) => c.name === 'Acme Plumbing');
  check('Acme share 100%', acme?.sharePct === 100, `got ${acme?.sharePct}`);
  check('rating tied to highest-review snapshot (4.8/2400)',
    acme?.rating === 4.8 && acme?.reviews === 2400, `${acme?.rating}/${acme?.reviews}`);
  check('review gap = 2400 − 100 = 2300', acme?.reviewGap === 2300, `got ${acme?.reviewGap}`);
  check('rating delta = 4.8 − 4.5 = 0.3', acme?.ratingDelta === 0.3, `got ${acme?.ratingDelta}`);
  check('share gap = 100 − 30 = 70', acme?.shareGap === 70, `got ${acme?.shareGap}`);
  check('noise brand (1 cell) filtered out',
    !res.competitors.some((c) => c.name === 'One Off LLC'));
  check('headline leads with territorial dominance',
    /holds 100% of your map/.test(res.headline), res.headline);
}

// No competitors in pack → null (card hides).
const empty = computeCompetitorIntel({
  points: [{ rank: 1, competitors: [] }],
  own: { name: 'Bob', rating: null, reviews: null },
  totalCells: 1,
});
check('no competitors → null result', empty === null);

// Own-name self-exclusion: a franchise sibling sharing the first token is skipped.
const selfRes = computeCompetitorIntel({
  points: Array.from({ length: 4 }, () => ({
    rank: 1,
    competitors: [{ name: 'Bob Plumbing Downtown', rank_group: 1 }],
  })),
  own: { name: 'Bob Plumbing', rating: null, reviews: null },
  totalCells: 4,
});
check('own brand variants excluded from competitors', selfRes === null);

// ── Own AMR ─────────────────────────────────────────────────────────────
// The card's AMR column compares the client against competitors, so the
// client's own row has to carry a real number on the same scale. It used
// to be hardcoded to an em-dash in CompetitorIntelCard, which read as
// "unmeasurable" on every profile.
const amrPoints = [
  { rank: 1, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
  { rank: 2, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
  { rank: 3, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
  { rank: null, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
];
const amrRes = computeCompetitorIntel({
  points: amrPoints,
  own: { name: 'Bob Plumbing', rating: null, reviews: null },
  totalCells: 4,
});
check('own amr averages in-pack ranks only ((1+2+3)/3 = 2.0)',
  amrRes?.own.amr === 2, `got ${amrRes?.own.amr}`);
check('own amr ignores out-of-pack cells (share still 75%)',
  amrRes?.own.sharePct === 75, `got ${amrRes?.own.sharePct}`);

// Rounds to one decimal, same as competitor AMR: (1+2)/2 = 1.5.
const amrRound = computeCompetitorIntel({
  points: [
    { rank: 1, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
    { rank: 2, competitors: [{ name: 'Acme Plumbing', rank_group: 1 }] },
  ],
  own: { name: 'Bob Plumbing', rating: null, reviews: null },
  totalCells: 2,
});
check('own amr rounds to 1dp (1.5)', amrRound?.own.amr === 1.5, `got ${amrRound?.own.amr}`);

// Zero in-pack cells → null, NOT 0. A 0 would render as a better-than-#1
// rank and outrank every competitor in the table.
const amrNone = computeCompetitorIntel({
  points: Array.from({ length: 4 }, () => ({
    rank: null,
    competitors: [{ name: 'Acme Plumbing', rank_group: 1 }],
  })),
  own: { name: 'Bob Plumbing', rating: null, reviews: null },
  totalCells: 4,
});
check('own amr is null when the client holds no cells',
  amrNone !== null && amrNone.own.amr === null, `got ${amrNone?.own.amr}`);
check('own share is 0 when the client holds no cells',
  amrNone?.own.sharePct === 0, `got ${amrNone?.own.sharePct}`);

if (failures > 0) { console.error(`\nverify-competitor-intel: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-competitor-intel: all checks passed');
