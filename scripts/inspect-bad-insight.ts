import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from('ai_insights')
    .select('id, scan_id, diagnosis, projected_impact, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  for (const r of data ?? []) {
    console.log(`\nscan_id=${r.scan_id} (${r.created_at})\n  diagnosis: ${r.diagnosis}`);
  }
})();
