/**
 * Delete AI insights that were generated before the metric-persistence fix
 * (turf_coach_v1). They were based on scan rows where turf_score and
 * top3_win_rate were null, so Claude saw "0%" and concluded "prominence-
 * broken / GBP-filtered" even when the client was actually visible in many
 * cells.
 *
 * Safe re-run: only deletes v1 insights. New v2 insights are kept.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

async function main() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('ai_insights')
    .delete()
    .eq('prompt_version', 'turf_coach_v1')
    .select('id, scan_id');
  if (error) throw new Error(error.message);
  console.log(`Deleted ${data?.length ?? 0} stale v1 insights.`);
  for (const r of data ?? []) console.log(`  • ${r.id} (scan ${r.scan_id})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
