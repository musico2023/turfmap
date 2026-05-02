/**
 * Phase 7 verification — runs the new metric helpers against the existing
 * scan_points data for known clients and checks results against the spec's
 * expected values. Read-only — never writes to the database, so it's safe
 * to run before or after the 0003 migration is applied.
 *
 * Targets (from the redesign spec):
 *
 *   7.1 Kidcrew Medical (Toronto, "pediatrician")
 *       expected: reach ~17%, rank 2.6, score ~15, band "Invisible"
 *
 *   7.2 Logik Roofing (Oshawa, "roofer")
 *       expected: reach 100%, rank 2.19, score ~73, band "Dominant"
 *
 *   7.3 Zero-pack edge case (any client with 0 in-pack cells, e.g.
 *       Ivy's Touch Home Healthcare)
 *       expected: reach 0, rank null, score 0, band "Invisible"
 *
 *   7.4 Momentum case (any client with 2+ scans where score moved)
 *
 * Run with:  npx tsx scripts/verify-score-redesign.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { getServerSupabase } from '../lib/supabase/server';
import { turfReach } from '../lib/metrics/turfReach';
import { turfRank, turfRankCaption } from '../lib/metrics/turfRank';
import { composeTurfScore } from '../lib/metrics/turfScoreComposite';
import { momentum, momentumCaption } from '../lib/metrics/momentum';
import { getTurfScoreBand } from '../lib/metrics/turfScoreBands';

type Expected = {
  label: string;
  clientId: string;
  expected: {
    reachAround?: number;
    rankAround?: number | null;
    scoreAround?: number;
    band?: string;
  };
};

const TARGETS: Expected[] = [
  {
    label: '7.1 Kidcrew Medical (Toronto, "pediatrician")',
    clientId: '00000000-0000-4000-a000-000000000003',
    expected: {
      reachAround: 17,
      rankAround: 2.6,
      scoreAround: 15,
      band: 'Invisible',
    },
  },
  {
    label: '7.2 Logik Roofing (Oshawa, "roofer")',
    clientId: 'ffeb25fc-4a85-4fe4-ac9c-b954a99b5144',
    expected: {
      reachAround: 100,
      rankAround: 2.19,
      scoreAround: 73,
      band: 'Dominant',
    },
  },
  {
    label: "7.3 Ivy's Touch Home Healthcare (zero in-pack edge case)",
    clientId: '00000000-0000-4000-a000-000000000002',
    expected: {
      reachAround: 0,
      rankAround: null,
      scoreAround: 0,
      band: 'Invisible',
    },
  },
];

const TOLERANCE = 4; // points

async function checkClient(t: Expected): Promise<{
  passed: boolean;
  diff: string[];
}> {
  const supabase = getServerSupabase();
  const diff: string[] = [];

  // Most recent complete scan for the client.
  const { data: scan } = await supabase
    .from('scans')
    .select('id, completed_at')
    .eq('client_id', t.clientId)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!scan) {
    diff.push('  ✗ no complete scan found for this client');
    return { passed: false, diff };
  }

  const { data: pts } = await supabase
    .from('scan_points')
    .select('rank')
    .eq('scan_id', scan.id);
  const ranks = (pts ?? []).map((p) => (p.rank as number | null) ?? null);
  const total = ranks.length;
  const reach = turfReach(ranks, total);
  const rank = turfRank(ranks);
  const score = composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);

  console.log(`  scan: ${scan.id}  total cells: ${total}`);
  console.log(`  → TurfReach:  ${reach}%`);
  console.log(`  → TurfRank:   ${rank === null ? 'null' : rank.toFixed(2)}  (${turfRankCaption(rank)})`);
  console.log(`  → TurfScore:  ${score} / 100  (${band.label})`);

  const e = t.expected;
  if (e.reachAround !== undefined && Math.abs(reach - e.reachAround) > TOLERANCE) {
    diff.push(`  ✗ reach: got ${reach}, expected ~${e.reachAround} (±${TOLERANCE})`);
  }
  if (e.rankAround !== undefined) {
    if (e.rankAround === null && rank !== null) {
      diff.push(`  ✗ rank: got ${rank}, expected null`);
    } else if (e.rankAround !== null && rank === null) {
      diff.push(`  ✗ rank: got null, expected ~${e.rankAround}`);
    } else if (e.rankAround !== null && rank !== null && Math.abs(rank - e.rankAround) > 0.3) {
      diff.push(`  ✗ rank: got ${rank.toFixed(2)}, expected ~${e.rankAround} (±0.3)`);
    }
  }
  if (e.scoreAround !== undefined && Math.abs(score - e.scoreAround) > TOLERANCE) {
    diff.push(`  ✗ score: got ${score}, expected ~${e.scoreAround} (±${TOLERANCE})`);
  }
  if (e.band !== undefined && band.label !== e.band) {
    diff.push(`  ✗ band: got "${band.label}", expected "${e.band}"`);
  }
  return { passed: diff.length === 0, diff };
}

async function checkMomentum() {
  console.log('\n7.4 Momentum case — first client with 2+ scans');
  const supabase = getServerSupabase();
  // Find any client with multiple complete scans.
  const { data: scans } = await supabase
    .from('scans')
    .select('id, client_id, completed_at')
    .eq('status', 'complete')
    .order('client_id', { ascending: true })
    .order('completed_at', { ascending: true });
  if (!scans || scans.length < 2) {
    console.log('  (no client has 2+ complete scans yet — Momentum can only be verified after a re-scan)');
    return;
  }
  // Pick the first client with 2+ scans.
  const grouped = new Map<string, typeof scans>();
  for (const s of scans) {
    const arr = grouped.get(s.client_id) ?? [];
    arr.push(s);
    grouped.set(s.client_id, arr);
  }
  let found: { clientId: string; pair: typeof scans } | null = null;
  for (const [clientId, list] of grouped.entries()) {
    if (list.length >= 2) {
      found = { clientId, pair: list.slice(-2) };
      break;
    }
  }
  if (!found) {
    console.log('  (no client has 2+ complete scans yet)');
    return;
  }
  const [prev, cur] = found.pair;
  // Compute scores for both via the same helpers.
  const both: Array<{ id: string; score: number }> = [];
  for (const s of [prev, cur]) {
    const { data: pts } = await supabase
      .from('scan_points')
      .select('rank')
      .eq('scan_id', s.id);
    const ranks = (pts ?? []).map((p) => (p.rank as number | null) ?? null);
    const r = turfReach(ranks);
    const rk = turfRank(ranks);
    both.push({ id: s.id, score: composeTurfScore(r, rk) });
  }
  const m = momentum(both[1].score, both[0].score);
  console.log(`  client ${found.clientId.slice(0, 8)}`);
  console.log(`    prev scan ${both[0].id.slice(0, 8)} → score ${both[0].score}`);
  console.log(`    cur  scan ${both[1].id.slice(0, 8)} → score ${both[1].score}`);
  console.log(`    Momentum:  ${m === null ? 'null' : `${m > 0 ? '+' : ''}${m}`}  (${momentumCaption(m)})`);
}

async function main() {
  let allPass = true;
  for (const t of TARGETS) {
    console.log(`\n${t.label}`);
    const { passed, diff } = await checkClient(t);
    if (passed) {
      console.log('  ✓ all expectations met');
    } else {
      allPass = false;
      diff.forEach((line) => console.log(line));
    }
  }
  await checkMomentum();
  console.log('\n');
  if (allPass) {
    console.log('═══ ALL VERIFICATION TARGETS PASS ═══');
  } else {
    console.log('═══ SOME TARGETS FAILED — see above ═══');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
