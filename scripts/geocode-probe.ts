import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { geocodeAddress } from '../lib/geocoding/nominatim';

(async () => {
  const addrs = process.argv.slice(2);
  for (const addr of addrs) {
    const r = await geocodeAddress(addr);
    if (!r) { console.log(`${addr} → not found`); continue; }
    console.log(`${addr}\n  → ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}\n  → ${r.display_name}\n`);
    await new Promise((r) => setTimeout(r, 1100));
  }
})().catch((e) => { console.error(e); process.exit(1); });
