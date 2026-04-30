/**
 * Regenerate outputs/kidcrew-medical-pediatrician-scan.json from the most
 * recent Kidcrew scan, using current metric definitions (max-reach
 * turfRadius, brand-collapsed curated competitors). No DataForSEO calls —
 * pulls existing scan_points + competitors rows from Supabase.
 *
 * Run with:  npx tsx scripts/rebuild-kidcrew-output.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { turfRadius } from '../lib/metrics/turfRadius';
import { packStrength } from '../lib/metrics/packStrength';

const CLIENT_ID = '00000000-0000-4000-a000-000000000003';
const PRIMARY_KEYWORD = 'pediatrician';
const CENTER_LABEL = 'Toronto, ON — Wychwood (Bathurst & St. Clair)';
const SECONDARY_LOCATION = {
  address: '240 Duncan Mill Road, Toronto, ON M3B 3S6',
  latitude: 43.76214,
  longitude: -79.35142,
  label: 'North York / Don Valley East',
};
const SECONDARY_KEYWORDS = [
  'child psychologist',
  'pediatric occupational therapist',
  'ADHD assessment',
  'psychoeducational assessment',
];
const OUT_OF_PACK = 20;

type BrandPattern = { name: string; pattern: RegExp };
const COMPETITORS: BrandPattern[] = [
  { name: 'Nest Health',                  pattern: /nest\s+health/i },
  { name: 'Medcan',                       pattern: /\bmedcan\b/i },
  { name: 'Cleveland Clinic Canada',      pattern: /cleveland\s+clinic/i },
  { name: 'Don Mills Pediatrics',         pattern: /don\s+mills\s+p[ae]diatric/i },
  { name: 'Toronto Beach Pediatrics',     pattern: /toronto\s+beach/i },
  { name: 'True North Health Centre',     pattern: /true\s+north\s+health/i },
  { name: 'The Hospital for Sick Children', pattern: /sick\s*kids|hospital\s+for\s+sick/i },
  { name: 'Sunnybrook Pediatrics',        pattern: /sunnybrook/i },
  { name: 'North Toronto Pediatrics',     pattern: /north\s+toronto\s+p[ae]diatric/i },
  { name: 'Pediatric Alliance',           pattern: /p[ae]diatric\s+alliance/i },
  { name: 'Midtown Pediatrics',           pattern: /midtown\s+p[ae]diatric/i },
  { name: 'Everest Pediatric Clinic',     pattern: /everest\s+p[ae]diatric|everest\s+clinic/i },
  { name: 'Roundhouse Pediatrics',        pattern: /roundhouse\s+p[ae]diatric/i },
  { name: 'Bloorkids',                    pattern: /bloorkids|bloor\s+kids/i },
  { name: 'Kindercare Pediatrics',        pattern: /kindercare/i },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

function brandFor(name: string): string | null {
  for (const c of COMPETITORS) if (c.pattern.test(name)) return c.name;
  return null;
}

async function main() {
  const supabase = getServerSupabase();

  // Pull client + most recent complete scan
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', CLIENT_ID)
    .single();
  if (!client) throw new Error('Kidcrew client not found');

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', CLIENT_ID)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!scan) throw new Error('No complete Kidcrew scan');

  const { data: pts } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, competitors')
    .eq('scan_id', scan.id);
  const points = pts ?? [];

  // Build 9×9 grid of client ranks
  const grid: (number | null)[][] = Array.from({ length: 9 }, () =>
    Array<number | null>(9).fill(null)
  );
  for (const p of points) {
    grid[p.grid_y as number][p.grid_x as number] =
      (p.rank as number | null) ?? null;
  }

  // Aggregate metrics
  const ranksFlat = points.map((p) => (p.rank as number | null) ?? null);
  const inPackCount = ranksFlat.filter((r): r is number => r !== null).length;
  const avgRankCapped =
    ranksFlat.reduce<number>((sum, r) => sum + (r === null ? OUT_OF_PACK : r), 0) /
    ranksFlat.length;
  const pctTop3 = Math.round((inPackCount / ranksFlat.length) * 100);
  const turfscore = round1(100 - 5 * avgRankCapped);
  const pack_strength = packStrength(ranksFlat);
  const radiusUnits = turfRadius(
    points.map((p) => ({
      point: { x: p.grid_x as number, y: p.grid_y as number },
      rank: (p.rank as number | null) ?? null,
    })),
    9
  );
  const reachMiles = radiusUnits * ((client.service_radius_miles ?? 1.6) / 4);

  // Competitor leaderboard via curated brand patterns
  const ranksByBrand = new Map<string, number[]>();
  for (const p of points) {
    const list = (p.competitors ?? []) as Array<{
      name: string | null;
      rank_group: number | null;
      rank_absolute: number | null;
    }>;
    const cellBest = new Map<string, number>();
    for (const item of list) {
      if (!item?.name) continue;
      const brand = brandFor(item.name);
      if (!brand) continue;
      const rank = item.rank_group ?? item.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const prev = cellBest.get(brand);
      if (prev === undefined || rank < prev) cellBest.set(brand, rank);
    }
    for (const [brand, rank] of cellBest.entries()) {
      const arr = ranksByBrand.get(brand) ?? [];
      arr.push(rank);
      ranksByBrand.set(brand, arr);
    }
  }
  const competitors = COMPETITORS.map(({ name }) => {
    const ranks = ranksByBrand.get(name) ?? [];
    if (ranks.length === 0)
      return { name, avg_rank: OUT_OF_PACK, appears_in_cells: 0 };
    return {
      name,
      avg_rank: round1(ranks.reduce((a, b) => a + b, 0) / ranks.length),
      appears_in_cells: ranks.length,
    };
  }).sort((a, b) => a.avg_rank - b.avg_rank);

  // Where Kidcrew sits in the territory-adjusted leaderboard
  const kidcrewLeaderboardRow = {
    name: client.business_name,
    avg_rank: round1(avgRankCapped),
    appears_in_cells: inPackCount,
  };
  const fullLeaderboard = [...competitors, kidcrewLeaderboardRow].sort(
    (a, b) => a.avg_rank - b.avg_rank
  );
  const kidcrewPosition =
    fullLeaderboard.findIndex((row) => row.name === kidcrewLeaderboardRow.name) +
    1;

  // Top "wild" (non-curated) competitors actually appearing — useful pitch context
  const wildCounts = new Map<string, { count: number; ranks: number[] }>();
  for (const p of points) {
    const list = (p.competitors ?? []) as Array<{
      name: string | null;
      rank_group: number | null;
    }>;
    for (const c of list) {
      if (!c?.name) continue;
      const r = c.rank_group ?? null;
      if (r === null || r > 3) continue;
      const cur = wildCounts.get(c.name) ?? { count: 0, ranks: [] };
      cur.count++;
      cur.ranks.push(r);
      wildCounts.set(c.name, cur);
    }
  }
  const observedTop = [...wildCounts.entries()]
    .map(([name, v]) => ({
      name,
      appears_in_cells: v.count,
      avg_rank: round1(v.ranks.reduce((a, b) => a + b, 0) / v.ranks.length),
    }))
    .sort((a, b) => b.appears_in_cells - a.appears_in_cells || a.avg_rank - b.avg_rank)
    .slice(0, 10);

  const output = {
    client: client.business_name,
    keyword: PRIMARY_KEYWORD,
    scan_date: new Date(scan.completed_at as string).toISOString().slice(0, 10),
    center: {
      lat: client.latitude as number,
      lng: client.longitude as number,
      label: CENTER_LABEL,
    },
    radius_miles: client.service_radius_miles as number,
    turfscore,
    pack_strength,
    avg_rank: round1(avgRankCapped),
    pct_top_3: pctTop3,
    pct_top_10: pctTop3,
    pct_top_20: pctTop3,
    grid,
    competitors,
    client_rank_per_cell: grid,
    cost_cents: scan.dfs_cost_cents as number,
    _meta: {
      scan_id: scan.id,
      scan_completed_at: scan.completed_at,
      grid_size: 9,
      grid_spacing_miles: round1(
        (client.service_radius_miles as number) / 4
      ),
      dfs_endpoint: '/v3/serp/google/organic/live/advanced',
      failed_points: scan.failed_points ?? 0,
      kidcrew_match_pattern: 'kidcrew',
      kidcrew_leaderboard_position: kidcrewPosition,
      kidcrew_in_leaderboard: kidcrewLeaderboardRow,
      reach_miles_max: round1(reachMiles),
      followup_scan_address: SECONDARY_LOCATION,
      queued_secondary_keywords: SECONDARY_KEYWORDS,
      observed_top_competitors_unfiltered: observedTop,
      note_visibility_metrics:
        'pct_top_10 and pct_top_20 equal pct_top_3 because local-pack data only returns ranks 1-3.',
      note_pitch_framing:
        'Sickkids included for baseline reference, not competitive comparison. The actual competitive set for "pediatrician" is dominated by suburban GTA clinics (Peel, Maple Kidz, Dream Kids Oakville, etc.) — see observed_top_competitors_unfiltered. Curated brand list (Medcan, Cleveland Clinic, Nest Health, etc.) mostly absent because those brands market themselves as concierge/executive medicine, not pediatricians.',
    },
  };

  const outDir = path.resolve(process.cwd(), 'outputs');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'kidcrew-medical-pediatrician-scan.json');
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  // Console summary
  const winner = competitors[0];
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${client.business_name} — TurfMap (revised)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  scan_id            : ${scan.id}`);
  console.log(`  completed          : ${scan.completed_at}`);
  console.log(`  keyword            : "${PRIMARY_KEYWORD}"`);
  console.log(`  center             : ${CENTER_LABEL}`);
  console.log(`  grid               : 9x9, ${client.service_radius_miles}-mi axis radius`);
  console.log(`  TurfScore          : ${turfscore} / 100  (territory coverage)`);
  console.log(`  Pack Strength      : ${pack_strength === null ? '—' : pack_strength + ' / 100'}  (rank quality where present)`);
  console.log(`  avg rank (capped)  : ${round1(avgRankCapped)}`);
  console.log(`  in 3-pack          : ${inPackCount} / 81 cells (${pctTop3}%)`);
  console.log(`  TurfRadius (reach) : ${round1(reachMiles)}mi (max distance from pin)`);
  console.log(`  Kidcrew position   : #${kidcrewPosition} of ${fullLeaderboard.length}`);
  console.log(`  cost (this scan)   : $${((scan.dfs_cost_cents as number) / 100).toFixed(2)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  Curated leaderboard (your tracked brands):');
  for (const c of competitors) {
    const tag =
      c.appears_in_cells === 0
        ? '— not in local pack'
        : `${c.appears_in_cells} cells`;
    console.log(
      `    avg ${String(c.avg_rank).padStart(4)}  ${c.name.padEnd(34)} ${tag}`
    );
  }
  console.log('');
  console.log('  Top observed (unfiltered) — actual competitive set:');
  for (const c of observedTop.slice(0, 8)) {
    console.log(
      `    ${String(c.appears_in_cells).padStart(2)} cells, avg ${String(c.avg_rank).padStart(3)}  ${c.name}`
    );
  }
  console.log('');
  console.log(`  Heatmap (· = not in pack, [N] = center cell):`);
  for (let y = 0; y < 9; y++) {
    let row = '    ';
    for (let x = 0; x < 9; x++) {
      const v = grid[y][x];
      const cell = v === null ? '·' : String(v);
      const center = x === 4 && y === 4;
      row += center ? `[${cell}]` : ` ${cell} `;
    }
    console.log(row);
  }
  console.log('');
  console.log(`  Output: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
