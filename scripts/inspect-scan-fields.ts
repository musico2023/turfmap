import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from('scans')
    .select('id, client_id, turf_score, top3_win_rate, turf_radius_units, dfs_cost_cents, total_points, failed_points')
    .in('client_id', [
      '00000000-0000-4000-a000-000000000001',
      '00000000-0000-4000-a000-000000000002',
      '00000000-0000-4000-a000-000000000003',
    ])
    .order('completed_at', { ascending: false })
    .limit(10);
  console.table(data);
})();
