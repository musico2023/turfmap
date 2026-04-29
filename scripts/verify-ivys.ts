import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

const SCAN_ID = 'aa2d5266-f72d-4a71-a927-aaf1b4078ba9';

async function main() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, competitors')
    .eq('scan_id', SCAN_ID);
  if (error) throw error;

  const ivyHits: Array<{ x: number; y: number; name: string }> = [];
  for (const row of data ?? []) {
    const comps = (row.competitors ?? []) as Array<{ name: string | null }>;
    for (const c of comps) {
      if (c.name && /ivy/i.test(c.name)) {
        ivyHits.push({ x: row.grid_x, y: row.grid_y, name: c.name });
      }
    }
  }
  console.log(`"ivy" anywhere in 81 cells: ${ivyHits.length}`);
  if (ivyHits.length > 0) console.log(JSON.stringify(ivyHits, null, 2));

  console.log('\nSample local pack at center cell (4,4):');
  const center = data?.find((r) => r.grid_x === 4 && r.grid_y === 4);
  console.log(JSON.stringify(center?.competitors, null, 2));

  console.log('\nSample local pack at the cell closest to client address (4,4 is dead center; checking 4,5 too):');
  const south = data?.find((r) => r.grid_x === 4 && r.grid_y === 5);
  console.log(JSON.stringify(south?.competitors, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
