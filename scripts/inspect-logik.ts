import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

(async () => {
  const supabase = getServerSupabase();
  const CLIENT_ID = 'ffeb25fc-4a85-4fe4-ac9c-b954a99b5144';

  const { data: client } = await supabase
    .from('clients').select('business_name, address, service_radius_miles')
    .eq('id', CLIENT_ID).single();
  console.log('CLIENT:', client);

  const { data: scan } = await supabase
    .from('scans').select('*')
    .eq('client_id', CLIENT_ID).eq('status', 'complete')
    .order('completed_at', { ascending: false }).limit(1).maybeSingle();
  console.log('SCAN:', { id: scan?.id, turf_score: scan?.turf_score, top3_win_rate: scan?.top3_win_rate, turf_radius_units: scan?.turf_radius_units });

  const { data: pts } = await supabase
    .from('scan_points').select('rank').eq('scan_id', scan!.id);
  const ranks = (pts ?? []).map(p => p.rank as number | null);
  const inPack = ranks.filter(r => r !== null).length;
  const nulls = ranks.length - inPack;
  const sumWhenPresent = ranks.filter((r): r is number => r !== null).reduce((a,b) => a+b, 0);
  const avgWhenPresent = inPack ? sumWhenPresent / inPack : null;
  const sumAll = ranks.reduce<number>((s, r) => s + (r === null ? 20 : r), 0);
  const amr = sumAll / ranks.length;

  const histo = new Map<string, number>();
  for (const r of ranks) {
    const key = r === null ? 'null' : String(r);
    histo.set(key, (histo.get(key) ?? 0) + 1);
  }
  console.log('\nDISTRIBUTION:', Object.fromEntries(histo));
  console.log(`in-pack: ${inPack}/81 (${Math.round(inPack/81*100)}%)`);
  console.log(`avg when present: ${avgWhenPresent?.toFixed(2)}`);
  console.log(`AMR (with null=20 penalty): ${amr.toFixed(2)}`);
  console.log(`TurfScore (100 - 5*AMR): ${Math.round(100 - 5*amr)}`);
  console.log(`Pack Strength (100 - 5*avg_when_present): ${avgWhenPresent ? Math.round(100 - 5*avgWhenPresent) : null}`);
})();
