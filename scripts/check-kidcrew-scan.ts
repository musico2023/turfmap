import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
import { turfRadius } from '../lib/metrics/turfRadius';
(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from('scans')
    .select('id, completed_at, turf_score, top3_win_rate, turf_radius_units, status')
    .eq('client_id', '00000000-0000-4000-a000-000000000003')
    .order('completed_at', { ascending: false });
  console.table(data);
  if (data && data.length > 0) {
    const latest = data[0];
    const { data: pts } = await supabase
      .from('scan_points')
      .select('grid_x, grid_y, rank')
      .eq('scan_id', latest.id);
    const radius = turfRadius(
      (pts ?? []).map(p => ({ point: { x: p.grid_x, y: p.grid_y }, rank: p.rank })),
      9
    );
    console.log(`\nrecomputed turfRadius for ${latest.id}: ${radius} (× 6.25mi = ${(radius * 6.25).toFixed(1)}mi)`);
  }
})();
