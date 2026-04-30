import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '/Users/anthonyalfonsi/Claude/turfmap/lib/supabase/server';

const SCAN_ID = 'da4a816c-1748-4654-ae20-ee2b938b7ff9';
(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase.from('scan_points').select('competitors').eq('scan_id', SCAN_ID);
  const counts = new Map<string, { count: number; ranks: number[] }>();
  for (const row of data ?? []) {
    const list = (row.competitors ?? []) as Array<{ name: string | null; rank_group: number | null }>;
    for (const c of list) {
      if (!c?.name) continue;
      const rank = c.rank_group ?? null;
      if (rank === null || rank > 3) continue;
      const cur = counts.get(c.name) ?? { count: 0, ranks: [] };
      cur.count++; cur.ranks.push(rank);
      counts.set(c.name, cur);
    }
  }
  const top = [...counts.entries()]
    .map(([name, v]) => ({ name, count: v.count, avg: +(v.ranks.reduce((a,b)=>a+b,0)/v.ranks.length).toFixed(1) }))
    .sort((a,b) => b.count - a.count).slice(0, 12);
  console.table(top);
})();
