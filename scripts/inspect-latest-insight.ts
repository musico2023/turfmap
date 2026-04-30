import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';

(async () => {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from('ai_insights')
    .select('id, scan_id, prompt_version, diagnosis, actions, projected_impact, created_at')
    .eq('scan_id', 'da4a816c-1748-4654-ae20-ee2b938b7ff9')
    .order('created_at', { ascending: false })
    .limit(1);
  console.log(JSON.stringify(data, null, 2));
})();
