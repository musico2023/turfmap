/**
 * scripts/verify-audit-pipeline.ts
 *
 * Smoke test for the Phase 1 Visibility Audit pipeline pure functions:
 *
 *   - LLM Fit Score: every disqualifier path + the positive-signal
 *     additions + the confidence penalty
 *   - Action category metadata: every category resolves; nudges
 *     suppress on DIY-easy and on non-LLM-covered categories
 *   - Heuristic lift table: per-category base lifts + diminishing
 *     returns for repeated categories
 *
 * Run with: npx tsx scripts/verify-audit-pipeline.ts
 *
 * Prints a PASS/FAIL summary. No external calls. Safe to run anywhere.
 */

import {
  computeLlmFitScore,
  inferRevenueBand,
  llmFitLabel,
  shouldPitchLlm,
} from '../lib/audit/llmFitScore';
import {
  ACTION_CATEGORIES,
  ACTION_CATEGORY_BY_ID,
  isLlmCovered,
  nudgeForAction,
} from '../lib/audit/actionCategories';
import {
  HEURISTIC_LIFTS,
  liftForAction,
} from '../lib/ai/roadmapGenerator';
import type { ActionCategory } from '../lib/supabase/types';

let passed = 0;
let failed = 0;

function expect(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

// ─── inferRevenueBand ────────────────────────────────────────────────────
section('inferRevenueBand');
expect(
  '< 50 reviews → low',
  inferRevenueBand(30) === 'low',
  String(inferRevenueBand(30))
);
expect(
  '50-149 reviews → mid',
  inferRevenueBand(100) === 'mid',
  String(inferRevenueBand(100))
);
expect(
  '>=150 reviews → high',
  inferRevenueBand(200) === 'high',
  String(inferRevenueBand(200))
);
expect('null → null', inferRevenueBand(null) === null);
expect('undefined → null', inferRevenueBand(undefined) === null);

// ─── computeLlmFitScore: disqualifiers ───────────────────────────────────
section('computeLlmFitScore: hard disqualifiers');

const outsideTrade = computeLlmFitScore({
  tradeFit: false,
  metroFit: true,
  reviewCount: 200,
});
expect(
  'tradeFit=false → score 1',
  outsideTrade.score === 1,
  `got ${outsideTrade.score}`
);
expect(
  'tradeFit=false records rule hit',
  outsideTrade.rule_hits.includes('disqualifier:trade_outside_scope')
);

const smallMarket = computeLlmFitScore({
  tradeFit: true,
  metroFit: false,
  reviewCount: 200,
});
expect(
  'metroFit=false → score 1',
  smallMarket.score === 1,
  `got ${smallMarket.score}`
);
expect(
  'metroFit=false records rule hit',
  smallMarket.rule_hits.includes('disqualifier:small_market')
);

const lowRevenue = computeLlmFitScore({
  tradeFit: true,
  metroFit: true,
  reviewCount: 25,
});
expect(
  'reviewCount=25 (inferred low) → score 1',
  lowRevenue.score === 1,
  `got ${lowRevenue.score}`
);
expect(
  'low-revenue records rule hit',
  lowRevenue.rule_hits.includes('disqualifier:revenue_below_threshold')
);

const explicitLow = computeLlmFitScore({
  revenueBand: 'low',
  tradeFit: true,
  metroFit: true,
});
expect(
  'explicit revenueBand=low → score 1',
  explicitLow.score === 1,
  `got ${explicitLow.score}`
);

// ─── computeLlmFitScore: positive scoring ────────────────────────────────
section('computeLlmFitScore: positive scoring');

// Strong fit: high revenue + ad-active + reviews>150
const strongFit = computeLlmFitScore({
  revenueBand: 'high',
  tradeFit: true,
  metroFit: true,
  adActive: true,
  reviewCount: 218,
});
expect(
  'high revenue + ad-active + 200 reviews → score 5',
  strongFit.score === 5,
  `got ${strongFit.score}`
);
expect(
  'strong fit fires all positive rules',
  strongFit.rule_hits.includes('positive:revenue_high') &&
    strongFit.rule_hits.includes('positive:ad_active') &&
    strongFit.rule_hits.includes('positive:review_velocity')
);

// Mid revenue, no ads, mid reviews → 3 (base, no positives)
const midFit = computeLlmFitScore({
  revenueBand: 'mid',
  tradeFit: true,
  metroFit: true,
  adActive: false,
  reviewCount: 80,
});
expect(
  'mid revenue, no boosts → score 3',
  midFit.score === 3,
  `got ${midFit.score}`
);

// Unknown revenue → confidence penalty
const unknownRevenue = computeLlmFitScore({
  tradeFit: true,
  metroFit: true,
});
expect(
  'no revenue signal → score 2 (confidence penalty applied)',
  unknownRevenue.score === 2,
  `got ${unknownRevenue.score}`
);
expect(
  'unknown revenue records penalty rule',
  unknownRevenue.rule_hits.includes('penalty:revenue_unknown')
);

// Score is capped at 5
const overcapped = computeLlmFitScore({
  revenueBand: 'high',
  tradeFit: true,
  metroFit: true,
  adActive: true,
  reviewCount: 500,
});
expect(
  'all positive signals capped at 5',
  overcapped.score === 5,
  `got ${overcapped.score}`
);

// ─── shouldPitchLlm + llmFitLabel ────────────────────────────────────────
section('shouldPitchLlm + llmFitLabel');
expect('shouldPitchLlm(5) === true', shouldPitchLlm(5));
expect('shouldPitchLlm(4) === true', shouldPitchLlm(4));
expect('shouldPitchLlm(3) === false', !shouldPitchLlm(3));
expect('shouldPitchLlm(1) === false', !shouldPitchLlm(1));
expect('llmFitLabel(5) === Strong fit', llmFitLabel(5) === 'Strong fit');
expect('llmFitLabel(1) === Not fit', llmFitLabel(1) === 'Not fit');

// ─── action categories ──────────────────────────────────────────────────
section('action categories');

const expectedCategories: ActionCategory[] = [
  'review_velocity',
  'directory_claiming',
  'gbp_optimization',
  'gbp_photos',
  'schema_integration',
  'nap_consistency',
  'other',
];

for (const cat of expectedCategories) {
  expect(
    `category "${cat}" resolves via map`,
    ACTION_CATEGORY_BY_ID[cat]?.id === cat
  );
}

expect(
  '"other" is NOT LLM-covered',
  isLlmCovered('other') === false
);
expect(
  '"review_velocity" IS LLM-covered',
  isLlmCovered('review_velocity') === true
);

// All non-"other" categories should be LLM-covered.
for (const c of ACTION_CATEGORIES) {
  if (c.id === 'other') continue;
  expect(`${c.id} is LLM-covered`, c.llmCovered === true);
}

// ─── nudgeForAction visibility logic ────────────────────────────────────
section('nudgeForAction');

expect(
  'DIY-easy + LLM-covered → null nudge',
  nudgeForAction({ category: 'review_velocity', difficulty: 'DIY-easy' }) === null
);
expect(
  'DIY-medium + LLM-covered → real nudge',
  (nudgeForAction({ category: 'review_velocity', difficulty: 'DIY-medium' }) ?? '')
    .length > 20
);
expect(
  'DIY-hard + LLM-covered → real nudge',
  (nudgeForAction({ category: 'gbp_photos', difficulty: 'DIY-hard' }) ?? '').length > 20
);
expect(
  'DIY-medium + non-LLM-covered → null nudge',
  nudgeForAction({ category: 'other', difficulty: 'DIY-medium' }) === null
);

// ─── heuristic lift math ────────────────────────────────────────────────
section('heuristic lift table');

for (const cat of expectedCategories) {
  expect(
    `${cat} has heuristic lift entry`,
    cat in HEURISTIC_LIFTS && HEURISTIC_LIFTS[cat].base > 0
  );
}

// Diminishing returns: 1st action gets full base, 2nd gets less
const firstReviewLift = liftForAction('review_velocity', 1);
const secondReviewLift = liftForAction('review_velocity', 2);
const thirdReviewLift = liftForAction('review_velocity', 3);
expect(
  'review_velocity 1st action = base 6',
  firstReviewLift === 6,
  `got ${firstReviewLift}`
);
expect(
  'review_velocity 2nd action < 1st (diminishing)',
  secondReviewLift < firstReviewLift,
  `got ${secondReviewLift}`
);
expect(
  'review_velocity 3rd action ≥ 1 (floor)',
  thirdReviewLift >= 1,
  `got ${thirdReviewLift}`
);

// Floor at 1 holds even at extreme positions
const veryDiminished = liftForAction('nap_consistency', 12);
expect(
  'nap_consistency at position 12 still ≥ 1',
  veryDiminished >= 1,
  `got ${veryDiminished}`
);

// ─── summary ────────────────────────────────────────────────────────────
console.log(
  `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`
);
if (failed > 0) process.exit(1);
