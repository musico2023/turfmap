import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
(async () => {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('scans')
    .select('id, turf_score, turf_reach, turf_rank, momentum')
    .limit(1);
  if (error) {
    console.log('MIGRATION NOT APPLIED. Error:', error.message);
    process.exit(2);
  }
  console.log('MIGRATION APPLIED. Sample row:', JSON.stringify(data?.[0], null, 2));
})();
