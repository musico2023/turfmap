/**
 * Seed the curated competitor list for Ivy's Touch into the `competitors` table.
 * Idempotent: re-running upserts on (client_id, competitor_name) and skips
 * conflicts on the (client_id, google_place_id) unique constraint (place_id is null).
 *
 * Run with:  npm run seed:ivys-competitors
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';

const CLIENT_ID = '00000000-0000-4000-a000-000000000002';

const COMPETITOR_BRANDS = [
  'Home Instead',
  'Comfort Keepers',
  'Visiting Angels',
  'IncrediCare',
  'Right at Home',
  'BrightStar Care',
  'Always Best Care',
  'Apollo Home Healthcare',
  'Senior Helpers',
  'Caring Senior Service',
  'Edna Home Care Services',
  'Ajir Home Care',
  'Mint Caregivers',
];

async function main() {
  const supabase = getServerSupabase();

  // Find existing rows so we can skip duplicates without relying on the
  // (client_id, google_place_id) unique constraint (place_id is null here).
  const { data: existing, error: selErr } = await supabase
    .from('competitors')
    .select('id, competitor_name')
    .eq('client_id', CLIENT_ID);
  if (selErr) throw new Error(`select failed: ${selErr.message}`);

  const existingNames = new Set(
    (existing ?? []).map((r) => r.competitor_name.toLowerCase())
  );

  const toInsert = COMPETITOR_BRANDS.filter(
    (b) => !existingNames.has(b.toLowerCase())
  ).map((b) => ({
    client_id: CLIENT_ID,
    competitor_name: b,
  }));

  if (toInsert.length === 0) {
    console.log('All 13 competitor brands already seeded. Nothing to do.');
    return;
  }

  const { data, error } = await supabase
    .from('competitors')
    .insert(toInsert)
    .select('competitor_name');
  if (error) throw new Error(`insert failed: ${error.message}`);

  console.log(`Inserted ${data?.length ?? 0} competitor rows for Ivy's Touch:`);
  for (const r of data ?? []) console.log(`  • ${r.competitor_name}`);
  console.log(
    `\nTotal seeded: ${
      (existing?.length ?? 0) + (data?.length ?? 0)
    } / ${COMPETITOR_BRANDS.length} brands.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
