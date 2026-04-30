/**
 * Backfill turf_score / top3_win_rate / turf_radius_units on any complete
 * scan rows that are missing those columns. Recomputes from scan_points.
 *
 * Why: my one-off scan scripts (scan-kidcrew, scan-ivys-touch) wrote a
 * scan row but forgot to update the metric columns when marking it
 * complete. The dashboard worked because it derives metrics from
 * scan_points on the fly — but the AI Coach reads the columns directly
 * and saw nulls, leading to "0% presence" misdiagnoses.
 *
 * Idempotent: skips rows that already have all three values.
 *
 * Run with:  npx tsx scripts/backfill-scan-metrics.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
import { turfScore, OUT_OF_PACK_RANK } from '../lib/metrics/turfScore';
import { top3Rate } from '../lib/metrics/top3Rate';
import { turfRadius } from '../lib/metrics/turfRadius';

async function main() {
  const supabase = getServerSupabase();
  const { data: scans, error } = await supabase
    .from('scans')
    .select('id, status, turf_score, top3_win_rate, turf_radius_units')
    .eq('status', 'complete');
  if (error) throw new Error(error.message);

  const stale = (scans ?? []).filter(
    (s) => s.turf_score == null || s.top3_win_rate == null || s.turf_radius_units == null
  );

  if (stale.length === 0) {
    console.log('No scans need backfilling.');
    return;
  }

  console.log(`Found ${stale.length} scan(s) missing metrics. Backfilling…`);
  for (const s of stale) {
    const { data: pts } = await supabase
      .from('scan_points')
      .select('grid_x, grid_y, rank')
      .eq('scan_id', s.id);

    const ranks = (pts ?? []).map((p) => p.rank as number | null);
    const score = turfScore(ranks);
    const t3 = top3Rate(ranks);
    const radius = turfRadius(
      (pts ?? []).map((p) => ({
        point: { x: p.grid_x as number, y: p.grid_y as number },
        rank: p.rank as number | null,
      })),
      9,
      OUT_OF_PACK_RANK
    );

    const { error: upErr } = await supabase
      .from('scans')
      .update({
        turf_score: score,
        top3_win_rate: t3,
        turf_radius_units: radius,
      })
      .eq('id', s.id);

    if (upErr) {
      console.log(`  ✗ ${s.id}: ${upErr.message}`);
    } else {
      console.log(
        `  ✓ ${s.id}: turf_score=${score}, top3_win_rate=${t3}%, turf_radius_units=${radius}`
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
