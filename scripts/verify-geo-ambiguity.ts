/**
 * Guard: geo-sanity filtering for ambiguous-city keywords.
 *
 * Root cause (CertaPro of NW Metro Minneapolis, Dayton MN, 2026-07-11): a
 * scan for "painter dayton" scored 99 while the surfaced pack competitors
 * were painters in Dayton, OHIO. The scan is coordinate-anchored to Dayton
 * MN (the client ranks #1), but Google fills the pack slots the client
 * doesn't own with businesses from the prominent same-name city. Those
 * out-of-state businesses must never reach a client deliverable, and the
 * inflated score must be flagged.
 *
 * This pins the text-based state detection (the only geo signal DFS's
 * local_pack carries) + the ambiguity detector, so a refactor can't
 * silently (a) let an Ohio competitor through, or (b) false-match a state
 * on a name that has none.
 */

import {
  normalizeUsState,
  usStateFromText,
  competitorState,
  isOutOfRegion,
} from '../lib/metrics/geoRegion';
import { detectGeoAmbiguity, aggregateCompetitors } from '../lib/metrics/competitors';

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.error(`✗ ${label} — got ${g}, want ${w}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// normalizeUsState
check('normalize full name', normalizeUsState('Minnesota'), 'MN');
check('normalize lowercase', normalizeUsState('minnesota'), 'MN');
check('normalize abbr', normalizeUsState('mn'), 'MN');
check('normalize non-state', normalizeUsState('Ontario'), null);
check('normalize junk 2-char', normalizeUsState('ZZ'), null);

// usStateFromText — real local-pack titles/descriptions from the incident.
check('title with ", OH"', usStateFromText('Five Star Painting of Dayton, OH'), 'OH');
check('description "· Dayton, MN"', usStateFromText('10+ years in business · Dayton, MN'), 'MN');
check('full state name "Dayton, Ohio"', usStateFromText('Britton Paint · Dayton, Ohio'), 'OH');
check('no state in name → null', usStateFromText('Fresh Coat Painters of South Dayton'), null);
check('plain brand → null', usStateFromText('Paris Painting'), null);
// False-positive guards: 2-letter tokens that are NOT comma-delimited states.
check('"Inc" does not match IN', usStateFromText("Joe's Painting, Inc"), null);
check('bare two-letter word not matched', usStateFromText('That 1 Painter Twin Cities'), null);
check('null input', usStateFromText(null), null);

// competitorState — stored region wins over parsed name.
check('parsed from name', competitorState({ name: 'X of Dayton, OH' }), 'OH');
check('stored region wins', competitorState({ name: 'X of Dayton, OH', region: 'MN' }), 'MN');
check('stored full-name region', competitorState({ name: 'X', region: 'Minnesota' }), 'MN');

// isOutOfRegion
check('OH vs Minnesota → out', isOutOfRegion('OH', 'Minnesota'), true);
check('MN vs Minnesota → in', isOutOfRegion('MN', 'Minnesota'), false);
check('unknown competitor state → not out', isOutOfRegion(null, 'MN'), false);
check('unknown client region → not out', isOutOfRegion('OH', null), false);

// End-to-end: aggregation drops out-of-region + detector flags it.
const cell = (comps: Array<{ name: string; rank: number }>) => ({
  competitors: comps.map((c) => ({ name: c.name, rank_group: c.rank })),
});
// 4 cells: client region MN. Ohio competitor dominates; a real MN one too.
const points = [
  cell([{ name: 'Five Star Painting of Dayton, OH', rank: 2 }, { name: 'Brennan Painting, MN', rank: 3 }]),
  cell([{ name: 'Five Star Painting of Dayton, OH', rank: 2 }, { name: 'Brennan Painting, MN', rank: 3 }]),
  cell([{ name: 'Five Star Painting of Dayton, OH', rank: 1 }, { name: 'Brennan Painting, MN', rank: 3 }]),
  cell([{ name: 'Five Star Painting of Dayton, OH', rank: 1 }, { name: 'Brennan Painting, MN', rank: 2 }]),
];
const filtered = aggregateCompetitors(points, points.length, { clientRegion: 'Minnesota', topN: 5 });
check(
  'aggregation drops the Ohio competitor',
  filtered.map((c) => c.name),
  ['Brennan Painting, MN']
);
const amb = detectGeoAmbiguity(points, points.length, { clientRegion: 'Minnesota' });
check('detector flags ambiguous', amb.ambiguous, true);
check('detector names the OH offender', amb.outOfRegion, ['Five Star Painting of Dayton, OH']);
// Same-state scan is NOT flagged and nothing is dropped.
const cleanPoints = [
  cell([{ name: 'Brennan Painting, MN', rank: 1 }]),
  cell([{ name: 'Brennan Painting, MN', rank: 1 }]),
];
const cleanAmb = detectGeoAmbiguity(cleanPoints, cleanPoints.length, { clientRegion: 'Minnesota' });
check('same-state scan not flagged', cleanAmb.ambiguous, false);

if (failures > 0) {
  console.error(`\nverify-geo-ambiguity: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-geo-ambiguity: all checks passed');
