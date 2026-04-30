import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from('scan_points')
    .select('competitors')
    .eq('scan_id', 'da4a816c-1748-4654-ae20-ee2b938b7ff9');

  const names = new Set<string>();
  for (const row of data ?? []) {
    for (const c of (row.competitors ?? []) as Array<{ name: string | null }>) {
      if (c?.name) names.add(c.name);
    }
  }
  const list = [...names].sort();
  console.log(`Total unique competitor names in Kidcrew scan: ${list.length}`);
  for (const n of list) {
    if (/path|mill/i.test(n)) console.log(`  ⚠  ${n}`);
  }
  console.log('\n--- search for PATH or Mill ---');
  console.log(list.filter(n => /path|mill/i.test(n)).length, 'matches');
})();
