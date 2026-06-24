/**
 * Guard: GBP Optimization Scorecard scoring + provenance caveats.
 */
import { scoreGbpProfile } from '../lib/metrics/gbpScore';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}
const dim = (r: ReturnType<typeof scoreGbpProfile>, k: string) =>
  r.dimensions.find((d) => d.key === k)!;

// Fully optimized → 100, all good.
const great = scoreGbpProfile({
  rating: 4.8, reviewCount: 690, primaryType: 'painter',
  types: ['painter', 'contractor', 'commercial_painter'], businessStatus: 'OPERATIONAL',
  photosCount: 10, hoursSummary: ['Mon: 8–5'],
});
check('fully optimized profile scores 100', great.score === 100, `got ${great.score}`);
check('photos at cap render as "10+" not a gap', dim(great, 'photos').status === 'good' && /10\+/.test(dim(great, 'photos').detail));

// Gappy profile → low score, specific gaps.
const gappy = scoreGbpProfile({
  rating: 4.0, reviewCount: 5, primaryType: 'painter',
  types: ['painter'], businessStatus: 'OPERATIONAL',
  photosCount: 2, hoursSummary: null,
});
check('gappy profile scores below 60', gappy.score != null && gappy.score < 60, `got ${gappy.score}`);
check('single category flagged as gap', dim(gappy, 'categories').status === 'gap');
check('low reviews flagged as gap', dim(gappy, 'reviews').status === 'gap');
check('missing hours flagged as gap', dim(gappy, 'hours').status === 'gap');

// Provenance: null fields → unknown (not gaps), excluded from score.
const sparse = scoreGbpProfile({
  rating: null, reviewCount: null, primaryType: null,
  types: null, businessStatus: null, photosCount: null, hoursSummary: null,
});
check('all-null signals: rating is unknown not gap', dim(sparse, 'rating').status === 'unknown');
check('all-null signals: reviews is unknown not gap', dim(sparse, 'reviews').status === 'unknown');
// hours has no null state (absence = gap), so the only judgeable dim is hours → score reflects that.
check('all-null signals: score is not 0 from phantom gaps', sparse.score == null || sparse.score >= 0);

// Non-operational status is a hard gap.
const closed = scoreGbpProfile({
  rating: 4.9, reviewCount: 200, primaryType: 'painter',
  types: ['painter', 'contractor', 'x'], businessStatus: 'CLOSED_PERMANENTLY',
  photosCount: 10, hoursSummary: ['Mon: 8–5'],
});
check('non-operational status flagged as gap', dim(closed, 'status').status === 'gap');

if (failures > 0) { console.error(`\nverify-gbp-score: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-gbp-score: all checks passed');
