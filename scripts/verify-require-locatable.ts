import { hasLocatableCenter } from '../lib/intake/requireLocatable';
let failures = 0;
const check = (l: string, c: boolean) => { if (!c) { failures++; console.error(`✗ ${l}`); } else console.log(`✓ ${l}`); };
check('coords-only is locatable', hasLocatableCenter({ latitude: 39.5, longitude: -119.8, address: null }));
check('address-only is locatable', hasLocatableCenter({ latitude: null, longitude: null, address: '100 Queen St W, Toronto' }));
check('neither is rejected', !hasLocatableCenter({ latitude: null, longitude: null, address: null }));
check('blank address + no coords rejected', !hasLocatableCenter({ latitude: null, longitude: null, address: '   ' }));
if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nverify-require-locatable: all checks passed');
