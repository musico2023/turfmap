/**
 * Idempotently create the Supabase Storage buckets TurfMap needs.
 *
 *   client-logos: public read (so the white-label portal can show the
 *   logo without auth), writes restricted to service-role (no RLS
 *   policies on insert == only service-role keys succeed). Files live
 *   under <client_id>/<filename>.
 *
 * Run with:  npm run init:storage
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

const BUCKETS = [
  {
    id: 'client-logos',
    public: true,
    fileSizeLimit: 2 * 1024 * 1024, // 2 MB
    allowedMimeTypes: [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
    ],
  },
];

async function main() {
  const supabase = getServerSupabase();
  for (const cfg of BUCKETS) {
    const { data: existing } = await supabase.storage.getBucket(cfg.id);
    if (existing) {
      console.log(`✓ bucket "${cfg.id}" already exists (public=${existing.public})`);
      continue;
    }
    const { error } = await supabase.storage.createBucket(cfg.id, {
      public: cfg.public,
      fileSizeLimit: cfg.fileSizeLimit,
      allowedMimeTypes: cfg.allowedMimeTypes,
    });
    if (error) {
      console.error(`✗ failed to create "${cfg.id}":`, error.message);
      process.exit(1);
    }
    console.log(`+ created bucket "${cfg.id}"`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
