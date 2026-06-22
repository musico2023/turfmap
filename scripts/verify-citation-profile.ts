/** Guard: locationToCitationProfile runs the DFS audit for a SAB (name +
 *  city + coords) and only bails when the true minimum is missing. */
import { locationToCitationProfile } from '../lib/brightlocal/autoAudit';

let failures = 0;
const check = (label: string, cond: boolean) => {
  if (!cond) { failures++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`);
};

const sab = locationToCitationProfile('Anew Bathtub Repair', {
  phone: null, street_address: null, city: 'Reno', region: 'NV',
  postcode: null, country_code: 'USA', latitude: 39.52, longitude: -119.81,
});
check('SAB profile builds from name+city+coords', sab !== null);
check('SAB street_address defaults to empty', sab?.street_address === '');
check('SAB telephone null tolerated', sab?.telephone == null);

const noCity = locationToCitationProfile('X', {
  phone: null, street_address: null, city: null, region: 'NV',
  postcode: null, country_code: 'USA', latitude: 39.5, longitude: -119.8,
});
check('returns null without a city', noCity === null);

const noCoords = locationToCitationProfile('X', {
  phone: '7755551212', street_address: '1 A St', city: 'Reno', region: 'NV',
  postcode: '89501', country_code: 'USA', latitude: null, longitude: null,
});
check('returns null without coordinates', noCoords === null);

if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nverify-citation-profile: all checks passed');
