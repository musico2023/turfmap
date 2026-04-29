/**
 * Quick diagnostic: pulls the most recent scan and prints per-task DFS
 * status codes / messages from the first scan_point's raw_response.
 *
 * Use when the test scan reports 0 cost and all-failed points.
 *
 * Run with:  npx tsx scripts/diagnose-last-scan.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';

async function main() {
  const supabase = getServerSupabase();

  const { data: scan, error: e1 } = await supabase
    .from('scans')
    .select('id, status, dfs_cost_cents, failed_points, total_points, started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .single();
  if (e1 || !scan) throw new Error(`scan lookup: ${e1?.message}`);
  console.log('Most recent scan:', scan);

  // Pull only failed points: rows where raw_response is null OR has a
  // non-20000 status_code.
  const { data: points, error: e2 } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, business_found, raw_response')
    .eq('scan_id', scan.id);
  if (e2 || !points) throw new Error(`points lookup: ${e2?.message}`);

  const failures = points.filter((p) => {
    const raw = p.raw_response as Record<string, unknown> | null;
    return !raw || raw.status_code !== 20000;
  });

  console.log(`\n${failures.length} failed point(s):`);
  for (const p of failures) {
    const raw = p.raw_response as Record<string, unknown> | null;
    if (!raw) {
      console.log(`  (${p.grid_x},${p.grid_y}): raw_response is null`);
    } else {
      console.log(
        `  (${p.grid_x},${p.grid_y}): ${raw.status_code} ${raw.status_message}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
