/**
 * Guard: the NAP summary fed to the Roadmap AI must NOT leak raw null
 * NAP fields, and must frame what a found-but-unread listing means.
 *
 * Root cause (CertaPro, 2026-06-21): loadNapFindingsSummary dumped the raw
 * findings JSON into the roadmap-generator prompt. A directory citation is
 * matched by NAME but its phone/address are read only from the Google SERP
 * snippet, so they're usually null — e.g. Facebook came back
 * {status:"unverified", phone:null, address:null} even though the page
 * plainly shows (403) 220-1515. The AI read "phone": null as "this listing
 * has no phone" and the PDF told the client to add a phone to a listing
 * that already has one. Same class as the GBP provenance fix, extended to
 * directory citations: absence in OUR data ≠ absence in reality.
 */

import { summarizeNapFindingsForPrompt } from '../lib/audit/auditDataLoaders';

const findings = {
  citations: [
    { directory: 'google_business', name: 'CertaPro Painters', phone: '(403) 220-1515', address: '908 53 Ave NE', status: 'matched' },
    { directory: 'facebook', name: 'CertaPro Painters of Calgary & Central Alberta', phone: null, address: null, status: 'unverified' },
    { directory: 'bbb', name: 'CertaPro Painters of Calgary & Central Alberta', phone: null, address: null, status: 'unverified' },
  ],
  missing: [
    { directory: 'yelp', priority: 'high' },
    { directory: 'apple_maps', priority: 'medium' },
  ],
  inconsistencies: [],
};

const out = summarizeNapFindingsForPrompt(findings);

let failures = 0;
function check(label: string, cond: boolean) {
  if (!cond) { failures++; console.error(`✗ ${label}`); }
  else console.log(`✓ ${label}`);
}

check('lists facebook + bbb as FOUND', /facebook/.test(out) && /bbb/.test(out));
check('lists yelp as not-surfaced', /yelp/.test(out));
check('does NOT leak a raw "null" token', !/\bnull\b/.test(out));
check(
  'does NOT emit a bare "phone": field the AI can read as a gap',
  !/"phone"/.test(out) && !/phone:\s*(null|none|n\/a)/i.test(out)
);
check(
  'includes the snippet-provenance caveat',
  /search (results|snippet)/i.test(out) && /not\b/i.test(out)
);
check(
  'tells the AI not to recommend adding phone/address to a found listing',
  /add (a )?(phone|address)/i.test(out)
);

const f2 = {
  citations: [{ directory: 'google_business', status: 'matched' }],
  missing: [
    { directory: 'yelp', priority: 'high' },
    { directory: 'nextdoor', priority: 'low', occupied_by_sibling: { sibling_label: 'Downtown', sibling_address: '1 A St' } },
  ],
  inconsistencies: [],
};
const out2 = summarizeNapFindingsForPrompt(f2);
check('keeps high-priority grouping', /high-priority[^\n]*yelp/i.test(out2));
check('flags sibling-occupied directory', /nextdoor[^\n]*sibling/i.test(out2));

if (failures > 0) {
  console.error(`\nverify-nap-summary-framing: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-nap-summary-framing: all checks passed');
