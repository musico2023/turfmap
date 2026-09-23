/**
 * Guard for lib/business/franchise.ts.
 *
 * Fixtures are this book's real clients. The false-positive cases matter
 * most: telling an independent business it can't edit its own website is a
 * worse failure than missing a franchise.
 */
import { detectFranchise, splitOfName } from '../lib/business/franchise';
import {
  buildTurfCoachUserPrompt,
  TURF_COACH_SYSTEM_PROMPT,
  TURF_COACH_PROMPT_VERSION,
} from '../lib/anthropic/prompts/turfCoach';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { console.error(`✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`); failures++; }
  else console.log(`✓ ${name}`);
}

// ── real franchises in the book ───────────────────────────────────────
const fiveStar = detectFranchise({
  businessName: 'Five Star Painting of Austin',
  websiteUri: 'https://www.fivestarpainting.com/austin/?cid=LSTL_FSP-US000189',
});
check('Five Star Painting of Austin → franchise', fiveStar.isFranchise);
check('  … territory extracted', fiveStar.territory === 'Austin', fiveStar);
check('  … corporate host identified', fiveStar.corporateHost === 'fivestarpainting.com');
check('  … location path for the "ask corporate" ask', fiveStar.locationPath === '/austin', fiveStar);

check('CertaPro NW Metro → franchise',
  detectFranchise({ businessName: 'CertaPro Painters of Northwest Metro Minneapolis, MN' }).isFranchise);
check('CertaPro Calgary → franchise',
  detectFranchise({ businessName: 'CertaPro Painters of Calgary and Central Alberta' }).isFranchise);
check('Painter Bros of Indianapolis → franchise',
  detectFranchise({ businessName: 'Painter Bros of Indianapolis' }).isFranchise);
check('brand with no website still detected',
  detectFranchise({ businessName: 'Victors Home Solutions' }).isFranchise);
check('corporate host alone is enough (name not in brand list)',
  detectFranchise({ businessName: 'Some Local Crew', websiteUri: 'https://www.mrhandyman.com/greater-cleveland/' }).isFranchise);

// ── independents must NOT be flagged ──────────────────────────────────
const independents: [string, string | null][] = [
  ['Allbritten Heating, Air Conditioning, Plumbing, and Electrical', 'https://www.allbritten.com/'],
  ['Tri-County Services Electric & Plumbing', 'https://www.tricountyelectricservice.com/'],
  ['Fortress Leak Detection And Restoration', 'https://fortressleakdetectionandrestoration.com/'],
  ['Clear Choice Windows & Doors', 'https://clearchoiceconstruction.com/'],
  ['AtHome Improvement Solutions, Inc.', 'http://athomeimprovements.net/'],
  ['D Spot Dessert Cafe', 'https://dspotdessert.com/'],
  ['Barton Springs Painting', null],
  // Same words as a franchise brand, different company — an independent in
  // Greer, SC that is already a client.
  ['Five Star Plumbing, Heating, Cooling & Electrical', null],
];
for (const [name, site] of independents) {
  const r = detectFranchise({ businessName: name, websiteUri: site });
  check(`independent: ${name.slice(0, 42)}`, !r.isFranchise, r.signals);
}

// ── the "<X> of <Y>" shape alone must never fire ──────────────────────
check('"House of Pizza" is not a franchise', !detectFranchise({ businessName: 'House of Pizza' }).isFranchise);
check('"Bank of Ohio" is not a franchise', !detectFranchise({ businessName: 'Bank of Ohio' }).isFranchise);
check('"Chamber of Commerce" is not a franchise', !detectFranchise({ businessName: 'Springfield Chamber of Commerce' }).isFranchise);
check('own-domain page path is not a corporate path',
  detectFranchise({ businessName: 'Acme Roofing', websiteUri: 'https://acmeroofing.com/austin/' }).isFranchise === false);

// ── name splitting ────────────────────────────────────────────────────
check('splits on " of "', splitOfName('Five Star Painting of Austin')?.territory === 'Austin');
check('keeps a multi-word territory',
  splitOfName('CertaPro Painters of Northwest Metro Minneapolis, MN')?.territory === 'Northwest Metro Minneapolis, MN');
check('no " of " → null', splitOfName('Barton Springs Painting') === null);
check('empty → null', splitOfName('') === null);

// ── prompt wiring ─────────────────────────────────────────────────────
const basePrompt = {
  businessName: 'Five Star Painting of Austin', industry: 'painting',
  serviceArea: 'Austin, Texas', keyword: 'painter', turfScore: 27, turfReach: 37,
  turfRank: 2.2, momentum: null, gridRadiusMiles: 10, totalPoints: 81,
  failedPoints: 0, rankGrid: Array.from({ length: 9 }, () => Array(9).fill(null)),
  competitors: [],
};
const withFranchise = buildTurfCoachUserPrompt({ ...basePrompt, franchise: fiveStar });
const without = buildTurfCoachUserPrompt(basePrompt);

check('prompt: franchise section rendered', withFranchise.includes('## Franchise'));
check('prompt: names the corporate domain', withFranchise.includes('fivestarpainting.com'));
check('prompt: cites the location path for the corporate ask', withFranchise.includes('/austin'));
check('prompt: states the operator cannot publish there', /CANNOT publish or edit/.test(withFranchise));
check('prompt: closing reminder carries the constraint', /do not recommend building or editing pages on the corporate domain/i.test(withFranchise));
check('independent prompt has NO franchise section', !without.includes('## Franchise'));
check('independent prompt has no franchise reminder', !/corporate domain/i.test(without));

// System prompt must carry the executable-advice rules.
check('system prompt: franchisee rules present', TURF_COACH_SYSTEM_PROMPT.includes('## Franchisees'));
check('system prompt: bans corporate-domain page building',
  /NEVER recommend building, publishing or editing pages on the corporate domain/.test(TURF_COACH_SYSTEM_PROMPT));
check('system prompt: requires a named ask to corporate',
  /REQUEST TO CORPORATE/.test(TURF_COACH_SYSTEM_PROMPT));
check('system prompt: protects sibling franchisee territories',
  /sibling/i.test(TURF_COACH_SYSTEM_PROMPT.split('## Franchisees')[1] ?? ''));
check('prompt version bumped for the new system prompt', TURF_COACH_PROMPT_VERSION === 'turf_coach_v12');

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll franchise checks passed.');
