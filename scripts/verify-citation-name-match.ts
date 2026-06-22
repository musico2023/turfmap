/**
 * Guard: nameMatches must tolerate long legal names vs short directory
 * titles WITHOUT matching the wrong franchise location.
 *
 * Root cause (CertaPro, 2026-06-20): the canonical name "CertaPro Painters
 * OF Calgary AND Central Alberta" tokenizes to 7 tokens, two of which are
 * filler ("of", "and"). Directory titles routinely shorten ("CertaPro
 * Painters", "CertaPro Painters … Calgary, Alberta … Yelp"), so coverage
 * fell below the 0.75 containment bar and real listings (Yelp) were
 * reported "missing". Fix: strip generic connector tokens before scoring
 * so the bar is measured against DISTINCTIVE tokens only.
 *
 * The franchise guard is the safety rail: CertaPro is a multi-location
 * brand (Edmonton, Southern Alberta, South Calgary are SEPARATE
 * businesses). Loosening the bar must NOT let those match the Calgary
 * client — location tokens still have to line up.
 */

import { nameMatches } from '../lib/citations/napCompare';

const CANON = 'CertaPro Painters of Calgary and Central Alberta';

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got !== want) {
    failures++;
    console.error(`✗ ${label} — got ${got}, want ${want}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// SHOULD match — same business, shortened / qualifier-laden titles.
check(
  'full directory title (Facebook)',
  nameMatches(CANON, 'CertaPro Painters of Calgary & Central Alberta | Calgary AB'),
  true
);
check(
  'Yelp SERP title (short brand + address, drops "of/and/central")',
  nameMatches(
    CANON,
    'CERTAPRO PAINTERS - Updated April 2026 - 135 Photos - 908 53 Avenue NE, Calgary, Alberta - Painters - Phone Number - Yelp'
  ),
  true
);
check(
  'HomeStars title with review count',
  nameMatches(CANON, 'CertaPro Painters of Calgary & Central Alberta reviews (45)'),
  true
);

// MUST NOT match — different franchise locations (the safety rail).
check(
  'rejects CertaPro Edmonton (different city)',
  nameMatches(CANON, 'CertaPro Painters of Edmonton, AB | Edmonton AB | Facebook'),
  false
);
check(
  'rejects CertaPro Southern Alberta (different franchise)',
  nameMatches(CANON, 'CertaPro Painters of Southern Alberta'),
  false
);
check(
  'rejects a bare-trade title (no brand token)',
  nameMatches(CANON, 'Calgary Painters | Painting Company'),
  false
);

// Short-brand guard: a load-bearing stopword must not collapse the name to
// one token and match an unrelated business (review finding #1).
check(
  'rejects unrelated "Point" business for canonical "On Point Plumbing"',
  nameMatches('On Point Plumbing', 'Point Plumbing Supplies Inc'),
  false
);
check(
  'still matches long franchise name after the guard',
  nameMatches(CANON, 'CertaPro Painters of Calgary & Central Alberta | Calgary AB'),
  true
);
// No-regression: a single-word brand must still match a qualifier-rich
// directory title (the guard must NOT add a backward-containment gate that
// rejects single-word brands).
check(
  'single-word brand still matches a qualifier-rich title',
  nameMatches('Lululemon', 'Lululemon Athletica | 220 Yonge St | Yelp'),
  true
);

if (failures > 0) {
  console.error(`\nverify-citation-name-match: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-citation-name-match: all checks passed');
