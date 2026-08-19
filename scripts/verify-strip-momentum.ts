/**
 * Guard for lib/share/stripMomentum.ts.
 *
 * Fixtures are the REAL stored Coach copy from Clear Choice Windows & Doors
 * scan 9c43c786 (the case that motivated hide_momentum), plus the shapes we
 * must not damage.
 */
import { stripMomentumText, stripMomentumAction } from '../lib/share/stripMomentum';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { console.error(`✗ ${name}`); failures++; }
  else console.log(`✓ ${name}`);
}

// ── real projected_impact from the Clear Choice scan ────────────────────
const projected =
  'With Momentum at +24 resting on only two scan-day data points (17 → 41), ' +
  'the gain is real but not yet confirmed as a sustained trend; consistent ' +
  'execution of neighborhood content, citation expansion, and review velocity ' +
  'over 90 days could push TurfReach from 53% to 65–68% and TurfScore into ' +
  'the 48–55 range if current territorial gains hold.';
const scrubbedProjected = stripMomentumText(projected);
check('projected: momentum clause removed', !/momentum/i.test(scrubbedProjected ?? ''));
check('projected: score delta removed', !/17\s*→\s*41/.test(scrubbedProjected ?? ''));
check('projected: substance preserved', /65–68%/.test(scrubbedProjected ?? '') && /48–55/.test(scrubbedProjected ?? ''));
check('projected: reads as a sentence', /^[A-Z]/.test(scrubbedProjected ?? '') && /\.$/.test(scrubbedProjected ?? ''));

// Regression: ", and " is ambiguous — it separates clauses AND closes an
// Oxford list. Rejoining survivors with a fixed "; " mangled the list into
// "citation expansion; review velocity" (caught in prod, 2026-08-17).
check('projected: oxford list not mangled',
  /citation expansion, and review velocity/.test(scrubbedProjected ?? ''));
check('projected: no stray semicolon', !/;/.test(scrubbedProjected ?? ''));

// ── real action.why from the same scan ──────────────────────────────────
const action = {
  action: 'Accelerate review velocity to close gap with leading competitors',
  priority: 'MEDIUM',
  why:
    "Clear Choice's 281 reviews at 4.8★ trail Tualatin Valley Glass (637 " +
    'reviews, 20 cells) by 356 — that volume deficit creates a prominence ' +
    'ceiling suppressing reach in northern and eastern cells, and sustaining ' +
    'the +24 Momentum requires continued review growth to hold newly ' +
    'captured territory.',
};
const scrubbedAction = stripMomentumAction(action);
check('action: survives scrubbing', scrubbedAction !== null);
check('action: momentum clause removed', !/momentum/i.test(scrubbedAction?.why ?? ''));
check('action: review-gap substance kept', /281 reviews/.test(scrubbedAction?.why ?? '') && /637/.test(scrubbedAction?.why ?? ''));
check('action: other fields untouched', scrubbedAction?.priority === 'MEDIUM' && scrubbedAction?.action === action.action);

// ── must not damage momentum-free copy ──────────────────────────────────
const clean =
  "At TurfScore 41 ('Solid' band), Clear Choice is TurfReach-constrained at " +
  '53% — TurfRank of 2.3 confirms it wins cleanly where it appears.';
check('clean copy returned verbatim', stripMomentumText(clean) === clean);

// ── degenerate inputs ───────────────────────────────────────────────────
check('null → null', stripMomentumText(null) === null);
check('empty → null', stripMomentumText('   ') === null);
check('all-momentum → null', stripMomentumText('Momentum is +24.') === null);
check('action with no survivable why → dropped',
  stripMomentumAction({ why: 'Momentum at +24.', priority: 'HIGH' }) === null);
// A parenthetical score delta with no momentum word is still narration of one.
check('bare score delta stripped',
  !/\(17 → 41\)/.test(stripMomentumText('Scores moved (17 → 41) last week. Reach is 53% today.') ?? ''));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll strip-momentum checks passed.');
