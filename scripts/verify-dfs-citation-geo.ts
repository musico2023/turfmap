/**
 * Guard: DFS citation probes must geo-target with VALID inputs.
 *
 * Root cause this guards against (CertaPro, 2026-06-20): the site_serp
 * probe sent `location_name` built as "{city},{region},{country}" with a
 * raw 2-letter region code, e.g. "Calgary,AB,Canada". That is NOT a valid
 * DFS location — DFS expects the full subdivision name ("Calgary,Alberta,
 * Canada") — so the task returned zero results and EVERY site_serp probe
 * (Facebook, BBB, Yelp, HomeStars, …) falsely reported "missing". Because
 * most clients are enriched from Google Places (2-letter region codes),
 * this silently broke citation detection across ~half the book. Measured:
 * 35 audits with 2-letter regions → 1 site_serp match; 32 with full names
 * → 24. Only the coord-based google_business probe was immune.
 *
 * Two invariants enforced here:
 *   1. dfsLocationFromBusiness expands 2-letter codes to the full name.
 *   2. applyDfsGeo is coord-first (location_coordinate when lat/lng are
 *      present — the robust path the GBP probe already used), falling
 *      back to a region-expanded location_name only when coords absent.
 */

import {
  dfsLocationFromBusiness,
  applyDfsGeo,
  type CitationBusinessProfile,
} from '../lib/citations/dfsChecker';

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures++;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const base: Omit<CitationBusinessProfile, 'region' | 'latitude' | 'longitude'> = {
  name: 'CertaPro Painters of Calgary and Central Alberta',
  street_address: '908 53 Avenue Northeast',
  city: 'Calgary',
  postcode: 'T2E 6Y7',
  country: 'CAN',
};

// 1. Region expansion: 2-letter province/state code → full DFS name.
const ab = dfsLocationFromBusiness({ ...base, region: 'AB' });
check(
  'region "AB" expands to "Alberta" in location_name',
  ab === 'Calgary,Alberta,Canada',
  `got "${ab}"`
);

const us = dfsLocationFromBusiness({
  ...base,
  city: 'Denver',
  country: 'USA',
  region: 'CO',
});
check(
  'region "CO" expands to "Colorado" in location_name',
  us === 'Denver,Colorado,United States',
  `got "${us}"`
);

// Full names pass through unchanged (don't double-map).
const full = dfsLocationFromBusiness({ ...base, region: 'Ontario', city: 'Toronto' });
check(
  'full region name "Ontario" passes through unchanged',
  full === 'Toronto,Ontario,Canada',
  `got "${full}"`
);

// 2. applyDfsGeo is coord-first when lat/lng present.
const withCoords: Record<string, unknown> = {};
applyDfsGeo(withCoords, { ...base, region: 'AB', latitude: 51.0833, longitude: -114.0 });
check(
  'applyDfsGeo sets location_coordinate when coords present',
  withCoords.location_coordinate === '51.0833,-114,1',
  `got ${JSON.stringify(withCoords)}`
);
check(
  'applyDfsGeo omits location_name when coords present (no invalid string)',
  withCoords.location_name === undefined
);

// Fallback: no coords → region-expanded location_name (still valid).
const noCoords: Record<string, unknown> = {};
applyDfsGeo(noCoords, { ...base, region: 'AB', latitude: null, longitude: null });
check(
  'applyDfsGeo falls back to expanded location_name when coords absent',
  noCoords.location_name === 'Calgary,Alberta,Canada',
  `got ${JSON.stringify(noCoords)}`
);

if (failures > 0) {
  console.error(`\nverify-dfs-citation-geo: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-dfs-citation-geo: all checks passed');
