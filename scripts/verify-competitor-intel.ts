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

if (failures > 0) { console.error(`\nverify-competitor-intel: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-competitor-intel: all checks passed');
