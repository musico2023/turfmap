/**
 * Backfill historical scans corrupted by the first-word-regex client
 * matcher (fixed in dc93b2d).
 *
 * Recomputes, for every completed scan, which local-pack listing was
 * actually the client — using the same predicate runScanForLocation
 * now uses (nameMatches against business_name AND the location's GBP
 * display name) — then rewrites:
 *
 *   scan_points.rank / business_found   (per cell)
 *   scans.turf_score / turf_reach / turf_rank
 *   scans.momentum                       (re-derived from corrected scores)
 *
 * Momentum has to be redone even for scans whose own cells were clean,
 * because a scan's momentum is measured against the previous scan's
 * turf_score — and that baseline may itself have been corrected. The
 * baseline rule mirrors runScan: most recent completed scan for the
 * same (client, location, keyword) whose completed_at is more than
 * MOMENTUM_BASELINE_WINDOW_HOURS before this one's.
 *
 * Dry run by default. Pass --apply to write. Every original value that
 * would change is written to a backup JSON first, so the whole thing is
 * reversible via revert-scan-client-match-backfill.ts.
 *
 * Idempotent: re-running after an --apply finds zero changes. Already
 * applied in full on 2026-08-15 — 10,870 scan_points and 244 scans across
 * 761 completed scans. Kept in the repo because the same repair is needed
 * for any future matcher change, and because the revert path is only
 * meaningful alongside it.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { nameMatches } from '../lib/citations/napCompare';
import { cleanCompetitorName } from '../lib/dataforseo/cleanCompetitorName';
import { turfReach } from '../lib/metrics/turfReach';
import { turfRank } from '../lib/metrics/turfRank';
import { composeTurfScore } from '../lib/metrics/turfScoreComposite';
import { momentum as computeMomentum } from '../lib/metrics/momentum';

const APPLY = process.argv.includes('--apply');
const MOMENTUM_BASELINE_WINDOW_HOURS = 12;
const BACKUP_DIR = process.env.BF_BACKUP_DIR ?? '/tmp/turfmap-backfill';

type ScanRow = {
  id: string;
  client_id: string;
  location_id: string;
  keyword_id: string;
  turf_score: number | null;
  turf_reach: number | null;
  turf_rank: number | null;
  momentum: number | null;
  completed_at: string | null;
  created_at: string;
};

type PointBackup = { id: string; rank: number | null; business_found: boolean | null };
type ScanBackup = {
  id: string;
  turf_score: number | null;
  turf_reach: number | null;
  turf_rank: number | null;
  momentum: number | null;
};

async function main() {
  const sb = getServerSupabase();

  console.log(`mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}\n`);

  // ── Load clients + per-location GBP display names ───────────────────
  const { data: clients } = await sb.from('clients').select('id, business_name');
  const nameByClient = new Map((clients ?? []).map((c) => [c.id, c.business_name as string]));

  const { data: locs } = await sb.from('client_locations').select('id');
  const gbpByLocation = new Map<string, string | null>();
  for (const l of locs ?? []) {
    const { data: g } = await sb
      .from('gbp_signals')
      .select('raw')
      .eq('client_location_id', l.id)
      .order('fetched_at', { ascending: false })
      .limit(1);
    const raw = g?.[0]?.raw as Record<string, unknown> | undefined;
    const dn = raw?.displayName as { text?: string } | string | undefined;
    const t = typeof dn === 'string' ? dn : dn?.text;
    gbpByLocation.set(l.id, t && t.trim() ? t.trim() : null);
  }
  console.log(`loaded ${nameByClient.size} clients, ${gbpByLocation.size} locations ` +
    `(${[...gbpByLocation.values()].filter(Boolean).length} with a GBP name)\n`);

  // ── Load all completed scans, oldest first ──────────────────────────
  const scans: ScanRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from('scans')
      .select('id, client_id, location_id, keyword_id, turf_score, turf_reach, turf_rank, momentum, completed_at, created_at')
      .eq('status', 'complete')
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (!data?.length) break;
    scans.push(...(data as ScanRow[]));
    if (data.length < 1000) break;
  }
  console.log(`completed scans: ${scans.length}\n`);

  // ── Pass 1: recompute the score family per scan ─────────────────────
  const pointBackups: PointBackup[] = [];
  const pointWrites: Array<{ id: string; rank: number | null }> = [];
  const correctedScore = new Map<string, number>();
  let scansWithCellChanges = 0;
  let cellsCleared = 0;
  let cellsGained = 0;
  let skippedNoPoints = 0;

  for (const [i, s] of scans.entries()) {
    if (i % 100 === 0) process.stdout.write(`  scoring ${i}/${scans.length}\r`);
    const businessName = nameByClient.get(s.client_id);
    if (!businessName) continue;
    const gbp = gbpByLocation.get(s.location_id) ?? null;
    const names = [businessName, gbp].filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0
    );
    const isClient = (t: unknown) => {
      const cleaned = cleanCompetitorName(String(t ?? ''));
      return names.some((n) => nameMatches(n, cleaned));
    };

    const { data: pts } = await sb
      .from('scan_points')
      .select('id, rank, business_found, competitors')
      .eq('scan_id', s.id);
    if (!pts?.length) {
      skippedNoPoints++;
      correctedScore.set(s.id, Number(s.turf_score ?? 0));
      continue;
    }

    const ranks: (number | null)[] = [];
    let changedHere = 0;
    for (const p of pts) {
      const items = (p.competitors as { name?: string; rank_group?: number }[]) ?? [];
      const hit = items.find((x) => isClient(x?.name));
      const newRank = hit ? (hit.rank_group ?? null) : null;
      ranks.push(newRank);
      if (p.rank !== newRank) {
        changedHere++;
        if (p.rank !== null && newRank === null) cellsCleared++;
        if (p.rank === null && newRank !== null) cellsGained++;
        pointBackups.push({ id: p.id, rank: p.rank, business_found: p.business_found });
        pointWrites.push({ id: p.id, rank: newRank });
      }
    }
    if (changedHere > 0) scansWithCellChanges++;

    const reach = turfReach(ranks, 81);
    const rank = turfRank(ranks);
    correctedScore.set(s.id, composeTurfScore(reach, rank));
    // stash for pass 2
    (s as ScanRow & { _reach?: number; _rank?: number | null })._reach = reach;
    (s as ScanRow & { _reach?: number; _rank?: number | null })._rank = rank;
  }
  process.stdout.write('                                        \r');

  // ── Pass 2: re-derive momentum from corrected scores ────────────────
  // Series key = client + location + keyword, same as runScan's lookup.
  const byKey = new Map<string, ScanRow[]>();
  for (const s of scans) {
    const k = `${s.client_id}|${s.location_id}|${s.keyword_id}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }

  const scanBackups: ScanBackup[] = [];
  const scanWrites: Array<{ id: string; turf_score: number; turf_reach: number; turf_rank: number | null; momentum: number | null }> = [];
  let momentumChanged = 0;

  for (const series of byKey.values()) {
    series.sort((a, b) =>
      String(a.completed_at ?? a.created_at).localeCompare(String(b.completed_at ?? b.created_at))
    );
    for (const s of series) {
      const t = s as ScanRow & { _reach?: number; _rank?: number | null };
      if (t._reach === undefined) continue;
      const score = correctedScore.get(s.id)!;
      const selfAt = new Date(s.completed_at ?? s.created_at).getTime();
      const cutoff = selfAt - MOMENTUM_BASELINE_WINDOW_HOURS * 60 * 60 * 1000;
      let baseline: number | null = null;
      for (let j = series.length - 1; j >= 0; j--) {
        const cand = series[j];
        if (cand.id === s.id) continue;
        const candAt = new Date(cand.completed_at ?? cand.created_at).getTime();
        if (candAt < cutoff) {
          baseline = correctedScore.get(cand.id) ?? null;
          break;
        }
      }
      const mom = computeMomentum(score, baseline);

      const scoreChanged =
        Number(s.turf_score ?? -1) !== score ||
        Number(s.turf_reach ?? -1) !== t._reach ||
        (s.turf_rank === null ? null : Number(s.turf_rank)) !== t._rank;
      const momChanged = (s.momentum === null ? null : Number(s.momentum)) !== mom;
      if (momChanged) momentumChanged++;
      if (!scoreChanged && !momChanged) continue;

      scanBackups.push({
        id: s.id,
        turf_score: s.turf_score,
        turf_reach: s.turf_reach,
        turf_rank: s.turf_rank,
        momentum: s.momentum,
      });
      scanWrites.push({
        id: s.id,
        turf_score: score,
        turf_reach: t._reach,
        turf_rank: t._rank ?? null,
        momentum: mom,
      });
    }
  }

  // ── Report ──────────────────────────────────────────────────────────
  console.log('── scope ─────────────────────────────────────────────');
  console.log(`  scans examined            : ${scans.length}`);
  console.log(`  skipped (no scan_points)  : ${skippedNoPoints}`);
  console.log(`  scans with cell changes   : ${scansWithCellChanges}`);
  console.log(`  cells cleared (false pos) : ${cellsCleared}`);
  console.log(`  cells gained (false neg)  : ${cellsGained}`);
  console.log(`  scan_points to update     : ${pointWrites.length}`);
  console.log(`  scans to update           : ${scanWrites.length}`);
  console.log(`  ...of which momentum only : ${scanWrites.length - scansWithCellChanges > 0 ? momentumChanged : momentumChanged}`);

  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = String(scans.length) + '-' + String(pointWrites.length);
  const backupPath = path.join(BACKUP_DIR, `backup-${stamp}.json`);
  await writeFile(
    backupPath,
    JSON.stringify({ points: pointBackups, scans: scanBackups }, null, 0),
    'utf8'
  );
  console.log(`\n  backup written: ${backupPath}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────
  console.log('\n── applying ──────────────────────────────────────────');
  let done = 0;
  for (const w of pointWrites) {
    const { error } = await sb
      .from('scan_points')
      .update({ rank: w.rank, business_found: w.rank !== null })
      .eq('id', w.id);
    if (error) throw new Error(`scan_points ${w.id}: ${error.message}`);
    if (++done % 250 === 0) process.stdout.write(`  points ${done}/${pointWrites.length}\r`);
  }
  process.stdout.write('                                        \r');
  console.log(`  scan_points updated: ${pointWrites.length}`);

  done = 0;
  for (const w of scanWrites) {
    const { error } = await sb
      .from('scans')
      .update({
        turf_score: w.turf_score,
        turf_reach: w.turf_reach,
        turf_rank: w.turf_rank,
        momentum: w.momentum,
      })
      .eq('id', w.id);
    if (error) throw new Error(`scans ${w.id}: ${error.message}`);
    if (++done % 50 === 0) process.stdout.write(`  scans ${done}/${scanWrites.length}\r`);
  }
  process.stdout.write('                                        \r');
  console.log(`  scans updated: ${scanWrites.length}`);
  console.log('\n✓ backfill complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
