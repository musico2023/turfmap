/**
 * Seed Kidcrew Medical's curated competitor list (15 brands) into the
 * `competitors` table so the dashboard renders the agency-curated
 * leaderboard rather than the dynamic top-3 default.
 *
 * Run with:  npm run seed:kidcrew-competitors
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

const CLIENT_ID = '00000000-0000-4000-a000-000000000003';

const COMPETITOR_BRANDS = [
  'Nest Health',
  'Medcan',
  'Cleveland Clinic Canada',
  'Don Mills Pediatrics',
  'Toronto Beach Pediatrics',
  'True North Health Centre',
  'The Hospital for Sick Children',
  'Sunnybrook Pediatrics',
  'North Toronto Pediatrics',
  'Pediatric Alliance',
  'Midtown Pediatrics',
  'Everest Pediatric Clinic',
  'Roundhouse Pediatrics',
  'Bloorkids',
  'Kindercare Pediatrics',
];

async function main() {
  const supabase = getServerSupabase();

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
    console.log(`All ${COMPETITOR_BRANDS.length} competitor brands already seeded. Nothing to do.`);
    return;
  }

  const { data, error } = await supabase
    .from('competitors')
    .insert(toInsert)
    .select('competitor_name');
  if (error) throw new Error(`insert failed: ${error.message}`);

  console.log(`Inserted ${data?.length ?? 0} competitor rows for Kidcrew Medical:`);
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
