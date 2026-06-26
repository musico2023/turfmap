/**
 * Guard: local keyword candidate ranking (free-scan selection feeder).
 *
 * Enforces the core design rules: candidates fan out on SERVICE (not
 * geo-suffixes), the headline service ranks first, the city is a display
 * label only, and a novel vertical degrades gracefully instead of throwing.
 */
import {
  rankLocalKeywordCandidates,
  getKeywordStems,
  buildKeywordSuggestions,
} from '../lib/keywords/suggestions';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

// Plumbing in Calgary — headline service ("plumber") must win.
const plumb = rankLocalKeywordCandidates('plumber', 'Calgary');
check('returns candidates for a known vertical', plumb.length > 0);
check('top candidate is the headline service + city', plumb[0]?.keyword === 'plumber calgary', plumb[0]?.keyword);
check('top candidate is category-matched', plumb[0]?.categoryMatch === true);
check('priority is descending', plumb.every((c, i) => i === 0 || c.priority <= plumb[i - 1].priority));

// NO geo-suffix multiplication: count of candidates == count of stems
// (one per service), and none contain "near me" / "best" / "{neighborhood}".
const stems = getKeywordStems('plumber');
check('one candidate per service stem (no geo fan-out)', plumb.length === stems.length, `${plumb.length} vs ${stems.length}`);
check('no "near me" variants', !plumb.some((c) => /near me/i.test(c.keyword)));
check('no "best/top" variants', !plumb.some((c) => /\b(best|top)\b/i.test(c.keyword)));
check('all MVP candidates are service-intent', plumb.every((c) => c.intent === 'service'));

// City is display-only: same set, different label, same stems + order.
const noCity = rankLocalKeywordCandidates('plumber', null);
check('no-city candidates fall back to bare stems', noCity[0]?.keyword === 'plumber', noCity[0]?.keyword);
check('stem ordering is city-independent', noCity.map((c) => c.stem).join(',') === plumb.map((c) => c.stem).join(','));

// Novel vertical → literal fallback, not empty, not category-matched.
const novel = rankLocalKeywordCandidates('alpaca grooming', 'Reno');
check('novel vertical still yields a candidate', novel.length === 1 && novel[0].keyword === 'alpaca grooming reno', novel[0]?.keyword);
check('novel vertical flagged as not category-matched', novel[0]?.categoryMatch === false);

// Unknown / empty industry → empty (caller falls back to typed keyword).
check('empty industry → no candidates', rankLocalKeywordCandidates(null, 'Calgary').length === 0);

// limit is respected.
check('limit caps the list', rankLocalKeywordCandidates('plumber', 'Calgary', { limit: 2 }).length === 2);

// Regression: the legacy settings autocomplete export is unchanged.
check('buildKeywordSuggestions still composes stem × city',
  buildKeywordSuggestions('plumber', 'Calgary')[0] === 'plumber calgary');

if (failures > 0) { console.error(`\nverify-local-candidates: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-local-candidates: all checks passed');
