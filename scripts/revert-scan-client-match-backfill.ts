/**
 * Undo backfill-scan-client-match.ts --apply by restoring every original value from its
 * backup JSON.
 *
 * Usage: npx tsx scripts/_bf-revert.ts /tmp/turfmap-backfill/backup-<n>.json [--apply]
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';

const APPLY = process.argv.includes('--apply');
const file = process.argv.find((a) => a.endsWith('.json'));

async function main() {
  if (!file) throw new Error('pass the backup JSON path');
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    points: Array<{ id: string; rank: number | null; business_found: boolean | null }>;
    scans: Array<{
      id: string;
      turf_score: number | null;
      turf_reach: number | null;
      turf_rank: number | null;
      momentum: number | null;
    }>;
  };
  console.log(`restoring ${raw.points.length} scan_points + ${raw.scans.length} scans`);
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  if (!APPLY) return;

  const sb = getServerSupabase();
  let n = 0;
  for (const p of raw.points) {
    const { error } = await sb
      .from('scan_points')
      .update({ rank: p.rank, business_found: p.business_found })
      .eq('id', p.id);
    if (error) throw new Error(`scan_points ${p.id}: ${error.message}`);
    if (++n % 250 === 0) process.stdout.write(`  points ${n}/${raw.points.length}\r`);
  }
  n = 0;
  for (const s of raw.scans) {
    const { error } = await sb
      .from('scans')
      .update({
        turf_score: s.turf_score,
        turf_reach: s.turf_reach,
        turf_rank: s.turf_rank,
        momentum: s.momentum,
      })
      .eq('id', s.id);
    if (error) throw new Error(`scans ${s.id}: ${error.message}`);
    if (++n % 50 === 0) process.stdout.write(`  scans ${n}/${raw.scans.length}\r`);
  }
  console.log('\n✓ reverted');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
