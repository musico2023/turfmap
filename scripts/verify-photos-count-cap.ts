import { formatPhotosCount } from '../lib/anthropic/prompts/turfCoach';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok  :', msg);
}

// Google Places Place Details returns at most 10 photos, so photos_count
// is min(actual, 10). The Payless bug: photos_count === 10 (the cap) was
// rendered as a bare "10" and the AI Coach called it "critically thin".

// At/above the cap → cap-aware "10+" wording, explicitly not-thin.
const capped = formatPhotosCount(10);
assert(capped.startsWith('10+'), 'photos_count 10 renders as "10+" (capped), not a bare "10"');
assert(/do NOT treat as thin/i.test(capped), 'capped label tells the model not to treat it as thin');

// Defensive: anything >= 10 is capped (the API never returns > 10, but
// guard against future field-mask changes).
assert(formatPhotosCount(10) === formatPhotosCount(25), 'any value >= 10 renders identically (capped)');

// Genuinely low counts render as the plain number — a real photo gap.
assert(formatPhotosCount(0) === '0', 'photos_count 0 renders as plain "0"');
assert(formatPhotosCount(3) === '3', 'photos_count 3 renders as plain "3"');
assert(formatPhotosCount(9) === '9', 'photos_count 9 (just under cap) renders as plain "9"');

console.log('\nALL PASS');
