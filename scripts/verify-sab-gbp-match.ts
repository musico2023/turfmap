/**
 * Guard: the GBP strict-match gate must accept pure service-area
 * businesses while still rejecting wrong-business matches.
 *
 * Incident (2026-07/08): Google's Places TEXT SEARCH silently omits pure
 * service-area businesses — contractors with no public storefront. Both
 * GBP-linking paths are built on that search, so an SAB client was created
 * with google_place_id NULL, the NAP audit reported "no GBP found", and
 * the AI Coach's #1 recommendation became "create a Google Business
 * Profile" for businesses that had claimed, well-reviewed ones. It hit
 * Painter Bros of Indianapolis, Detailed Home Improvement, and Diversified
 * Tree Service (5.0★, 13 reviews) before being caught.
 *
 * Two halves to the fix, both pinned here:
 *   1. findBusinessPlaceIdViaDfs supplies a place_id when text search
 *      comes back empty (behavioural — exercised in the route, not here).
 *   2. isAcceptableMatch must not apply the DISTANCE gate to an SAB.
 *      Google returns no coordinates for them, so distance is UNKNOWABLE
 *      (Infinity in our code), and the storefront gate rejects every
 *      correct match. This guard is the regression fence for #2.
 *
 * The safety rail: dropping distance must NOT become "accept anything".
 * A weak name match is still rejected, and the SAB name bar is
 * deliberately HIGHER than the storefront bar since it is the only
 * signal left.
 */

import { isAcceptableMatch } from '../lib/google/places';

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got !== want) {
    failures++;
    console.error(`✗ ${label} — got ${got}, want ${want}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── Storefront businesses: unchanged behaviour ──────────────────────────
check(
  'storefront: close + good name → accept',
  isAcceptableMatch({ distanceM: 40, nameSimilarity: 0.8, isServiceAreaBusiness: false }),
  true
);
check(
  'storefront: too far → reject even with perfect name',
  isAcceptableMatch({ distanceM: 5000, nameSimilarity: 1.0, isServiceAreaBusiness: false }),
  false
);
check(
  'storefront: close but weak name → reject',
  isAcceptableMatch({ distanceM: 10, nameSimilarity: 0.3, isServiceAreaBusiness: false }),
  false
);
check(
  'storefront: exactly at the distance bound → accept',
  isAcceptableMatch({ distanceM: 100, nameSimilarity: 0.6, isServiceAreaBusiness: false }),
  true
);

// ── Service-area businesses: the incident cases ─────────────────────────
// Google gives an SAB no coordinates, so our haversine yields Infinity.
// Before the fix this rejected every SAB regardless of name quality.
check(
  'SAB: no coords (Infinity) + strong name → ACCEPT (the bug)',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 0.9,
    isServiceAreaBusiness: true,
  }),
  true
);
check(
  'SAB: exact name match with no coords → accept',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 1.0,
    isServiceAreaBusiness: true,
  }),
  true
);
check(
  'SAB: at the raised name bar (0.7) → accept',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 0.7,
    isServiceAreaBusiness: true,
  }),
  true
);

// ── Safety rail: relaxing distance must not accept wrong businesses ─────
check(
  'SAB: weak name → still REJECT (no blanket accept)',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 0.4,
    isServiceAreaBusiness: true,
  }),
  false
);
check(
  'SAB: name bar is STRICTER than storefront (0.6 passes storefront, fails SAB)',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 0.6,
    isServiceAreaBusiness: true,
  }),
  false
);
check(
  'SAB: zero name similarity → reject',
  isAcceptableMatch({
    distanceM: Number.POSITIVE_INFINITY,
    nameSimilarity: 0,
    isServiceAreaBusiness: true,
  }),
  false
);

if (failures > 0) {
  console.error(`\nverify-sab-gbp-match: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-sab-gbp-match: all checks passed');
