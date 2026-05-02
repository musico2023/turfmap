/**
 * Backfill the new score columns (turf_reach, turf_rank, momentum) and
 * recompute turf_score under the new composite formula for every
 * complete scan. Idempotent — run as many times as needed; last run
 * wins.
 *
 * Order:
 *   1. For each complete scan: compute turf_reach, turf_rank,
 *      turf_score from scan_points data and write back.
 *   2. After all scans have a turf_score, walk each client's scan
 *      timeline in order and compute momentum (delta vs. previous).
 *
 * Run with:  npx tsx scripts/backfill-new-scores.ts
 *
 * Adds a `--client <uuid>` flag for spot-checking a single client.
 * Adds a `--dry-run` flag to print computations without writing.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
import { turfReach } from '../lib/metrics/turfReach';
import { turfRank } from '../lib/metrics/turfRank';
import { composeTurfScore } from '../lib/metrics/turfScoreComposite';
import { momentum as computeMomentum } from '../lib/metrics/momentum';

type ScanRow = {
  id: string;
  client_id: string;
  status: string | null;
  completed_at: string | null;
  turf_score: number | null;
  turf_reach: number | null;
  turf_rank: number | null;
  momentum: number | null;
  total_points: number | null;
};

async function main() {
  const supabase = getServerSupabase();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const clientArg = argv.indexOf('--client');
  const onlyClient = clientArg >= 0 ? argv[clientArg + 1] : null;

  let q = supabase
    .from('scans')
    .select(
      'id, client_id, status, completed_at, turf_score, turf_reach, turf_rank, momentum, total_points'
    )
    .eq('status', 'complete')
    .order('completed_at', { ascending: true });
  if (onlyClient) q = q.eq('client_id', onlyClient);

  const { data: scans, error } = await q;
  if (error) throw new Error(error.message);
  if (!scans || scans.length === 0) {
    console.log('No complete scans to backfill.');
    return;
  }
  console.log(
    `${dryRun ? 'DRY-RUN: ' : ''}backfilling ${scans.length} scan(s)…`
  );

  // ─── Pass 1: per-scan turf_reach / turf_rank / turf_score ────────────────
  const refreshed = new Map<string, ScanRow>();
  for (const s of scans as ScanRow[]) {
    const { data: pts } = await supabase
      .from('scan_points')
      .select('rank')
      .eq('scan_id', s.id);
    const ranks = (pts ?? []).map((p) => (p.rank as number | null) ?? null);
    const totalCells = s.total_points ?? Math.max(ranks.length, 81);
    const reach = turfReach(ranks, totalCells);
    const rank = turfRank(ranks);
    const score = composeTurfScore(reach, rank);

    refreshed.set(s.id, {
      ...s,
      turf_reach: reach,
      turf_rank: rank,
      turf_score: score,
    });

    if (!dryRun) {
      const { error: upErr } = await supabase
        .from('scans')
        .update({
          turf_reach: reach,
          turf_rank: rank,
          turf_score: score,
        })
        .eq('id', s.id);
      if (upErr) {
        console.log(`  ✗ ${s.id}: ${upErr.message}`);
        continue;
      }
    }
    console.log(
      `  ${dryRun ? '·' : '✓'} ${s.id.slice(0, 8)} (client ${s.client_id.slice(0, 8)})  ` +
        `reach=${reach}%  rank=${rank ?? '—'}  turf_score=${score}`
    );
  }

  // ─── Pass 2: momentum across each client's scan timeline ─────────────────
  console.log(
    `\n${dryRun ? 'DRY-RUN: ' : ''}computing momentum across client timelines…`
  );
  const byClient = new Map<string, ScanRow[]>();
  for (const s of refreshed.values()) {
    const arr = byClient.get(s.client_id) ?? [];
    arr.push(s);
    byClient.set(s.client_id, arr);
  }

  for (const [clientId, list] of byClient.entries()) {
    list.sort((a, b) =>
      String(a.completed_at).localeCompare(String(b.completed_at))
    );
    let prev: ScanRow | null = null;
    for (const cur of list) {
      const m = prev
        ? computeMomentum(cur.turf_score, prev.turf_score)
        : null;

      if (!dryRun) {
        const { error: upErr } = await supabase
          .from('scans')
          .update({ momentum: m })
          .eq('id', cur.id);
        if (upErr) console.log(`  ✗ ${cur.id}: ${upErr.message}`);
      }
      console.log(
        `  client ${clientId.slice(0, 8)}  ${cur.id.slice(0, 8)}  ` +
          `score=${cur.turf_score}  prev=${prev?.turf_score ?? '—'}  momentum=${m ?? '—'}`
      );
      prev = cur;
    }
  }

  console.log(`\n${dryRun ? '(dry-run; no rows written)' : 'Backfill complete.'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
