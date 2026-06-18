import { resolveFoundNapForDirectory } from '../lib/citations/dfsChecker';
import { classifyCitation } from '../lib/citations/napCompare';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok  :', msg);
}

// Reproduces the Payless Kitchen Cabinets bug: a present, well-ranked
// GBP whose local_pack probe returns name+cid but NO phone/address.
const business = {
  telephone: '(800) 843-9246',
  street_address: '3614 San Fernando Road',
};
const NAME = 'Payless Kitchen Cabinets';

// 1. The bug, pre-fix: local_pack probe yields null NAP for google_business
//    → classifyCitation flags it 'unverified' (no phone/address).
const preFix = classifyCitation(
  { name: NAME, phone: business.telephone, address: business.street_address },
  { name: NAME, phone: null, address: null },
);
assert(preFix === 'unverified', 'pre-fix: google_business would be unverified (the reported bug)');

// 2. The fix: resolveFoundNapForDirectory restores the authoritative NAP
//    for google_business when the probe extracted nothing.
const [p, a] = resolveFoundNapForDirectory('google_business', business, null, null);
assert(p === '(800) 843-9246', 'fix: google_business phone restored from authoritative Google NAP');
assert(a === '3614 San Fernando Road', 'fix: google_business address restored from authoritative Google NAP');

// 3. With the restored NAP, classification is 'matched', not 'unverified'.
const postFix = classifyCitation(
  { name: NAME, phone: business.telephone, address: business.street_address },
  { name: NAME, phone: p, address: a },
);
assert(postFix === 'matched', 'fix: google_business classifies as matched');

// 4. Override is google_business-only — third-party directories still
//    rely on their real probe data (no authoritative override).
const [yp, ya] = resolveFoundNapForDirectory('yelp', business, null, null);
assert(yp === null && ya === null, 'non-google directory unaffected by the override');

// 5. Override does not clobber a real extracted value when present.
const [gp] = resolveFoundNapForDirectory('google_business', business, '(555) 111-2222', '1 Real St');
assert(gp === '(800) 843-9246', 'google_business prefers authoritative phone over extracted');

console.log('\nALL PASS');
