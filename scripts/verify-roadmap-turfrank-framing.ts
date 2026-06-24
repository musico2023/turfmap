/**
 * Guard: the roadmap generator must describe TurfRank as a 0–3 QUALITY
 * score (3 = best), never as a map "position".
 *
 * Regression: a perfect-rank/low-reach buyer (CertaPro: TurfRank 3.0,
 * appears #1 in 3/81 cells) was diagnosed as "ranking dead-last (position
 * 3.00)" in the PDF because the prompt labeled TurfRank "avg pack position
 * when present" — inverting it (3 read as 3rd place). The fix must keep the
 * prompt unambiguous so the model can't repeat the misread.
 */
import { buildUserPrompt } from '../lib/ai/roadmapGenerator';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`✓ ${label}`);
}

const prompt = buildUserPrompt({
  businessName: 'CertaPro Painters of Calgary',
  trade: 'Painting',
  keyword: 'painters calgary',
  market: 'Calgary, AB',
  currentTurfScore: 4,
  turfReach: 4,
  turfRank: 3, // perfect quality — always #1 where present
  napFindingsSummary: null,
  competitorSummary: null,
  cellPatternSummary: null,
});

const turfRankLine = prompt.split('\n').find((l) => l.includes('TurfRank')) ?? '';
check('prompt contains a TurfRank line', turfRankLine.length > 0);
check('TurfRank is NOT framed as a map position (the original bug)',
  !/avg pack position|position when present|\/3 \(.*position\b(?!\s*number)/i.test(turfRankLine), turfRankLine);
check('TurfRank line states higher is better / always #1',
  /higher is better/i.test(turfRankLine) || /always #1/i.test(turfRankLine), turfRankLine);
check('TurfReach is present so reach-vs-rank is distinguishable',
  /TurfReach/.test(prompt));

if (failures > 0) { console.error(`\nverify-roadmap-turfrank-framing: ${failures} check(s) failed`); process.exit(1); }
console.log('\nverify-roadmap-turfrank-framing: all checks passed');
