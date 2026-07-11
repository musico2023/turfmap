/**
 * Guard: GHL Listings sub-account provisioning body mapping.
 *
 * Context (2026-07-11): citations vendor pivot from BrightLocal (plan caps
 * active locations at 1) to GoHighLevel Listings. The provisioning body is
 * the contract with GHL's POST /locations/ — this pins the pure mapping so
 * a refactor can't silently ship a body GHL rejects (e.g. alpha-3 country
 * codes: GHL requires ISO-2, our profiles store alpha-3) or drop the
 * required companyId.
 */

import {
  countryAlpha3To2,
  buildGhlLocationBody,
} from '../lib/ghl/listings';
import type { CitationSubmittedProfile } from '../lib/supabase/types';

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

// Country mapping — GHL requires ISO-2; we store alpha-3.
check('USA → US', countryAlpha3To2('USA'), 'US');
check('CAN → CA', countryAlpha3To2('CAN'), 'CA');
check('lowercase can → CA', countryAlpha3To2('can'), 'CA');
check('already-ISO2 CA → CA', countryAlpha3To2('CA'), 'CA');
check('null → US default', countryAlpha3To2(null), 'US');
check('unknown → US default', countryAlpha3To2('MEX'), 'US');

const profile: CitationSubmittedProfile = {
  business_name: 'D Spot Dessert Cafe',
  street_address: '3432 East Hebron Parkway',
  city: 'Plano',
  region: 'Texas',
  postcode: '75187',
  country_code: 'USA',
  phone: '(214) 731-6423',
  website: 'https://dspotdessert.com/location/dallas/',
  primary_category: 'Dessert shop',
  additional_categories: ['Ice cream shop'],
  description: 'Best desserts in town.',
  hours: { mon: '11:00-00:00' },
  photo_urls: null,
};

const body = buildGhlLocationBody(
  {
    profile,
    contact: { firstname: 'Anthony', lastname: 'Alfonsi', email: 'a@fourdots.ca' },
    locationReference: 'loc-uuid',
  },
  'COMPANY123'
);

check('body.name', body.name, 'D Spot Dessert Cafe');
check('body.companyId (required)', body.companyId, 'COMPANY123');
check('body.country is ISO-2', body.country, 'US');
check('body.address', body.address, '3432 East Hebron Parkway');
check('body.city', body.city, 'Plano');
check('body.state', body.state, 'Texas');
check('body.postalCode', body.postalCode, '75187');
check('body.phone', body.phone, '(214) 731-6423');
check('body.website', body.website, 'https://dspotdessert.com/location/dallas/');
check('body.prospectInfo', body.prospectInfo, {
  firstName: 'Anthony',
  lastName: 'Alfonsi',
  email: 'a@fourdots.ca',
});

// Nullable fields are OMITTED (GHL rejects nulls on optional strings).
const sparse = buildGhlLocationBody(
  {
    profile: {
      ...profile,
      phone: null,
      street_address: null,
      city: null,
      region: null,
      postcode: null,
      website: null,
    },
    contact: { firstname: 'A', lastname: 'B', email: 'a@b.co' },
    locationReference: 'x',
  },
  'C1'
);
check('sparse body omits phone', 'phone' in sparse, false);
check('sparse body omits address', 'address' in sparse, false);
check('sparse body omits website', 'website' in sparse, false);
check('sparse body still has name+companyId+country', {
  name: sparse.name,
  companyId: sparse.companyId,
  country: sparse.country,
}, { name: 'D Spot Dessert Cafe', companyId: 'C1', country: 'US' });

if (failures > 0) {
  console.error(`\nverify-ghl-listings-provision: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-ghl-listings-provision: all checks passed');
