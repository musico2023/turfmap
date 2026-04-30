/**
 * Real-client scan: Kidcrew Medical (Toronto, ON).
 *
 * Run with:  npm run scan:kidcrew
 *
 * Forked from scan-ivys-touch.ts. Differences:
 *   - Different client UUID + flagship address (1440 Bathurst, Wychwood)
 *   - Toronto-specific competitor brands (15 total)
 *   - Brand patterns accept Canadian "paediatric" spelling alongside US
 *     "pediatric" (and Sickkids' multiple GBP listing variants)
 *   - 4 queued secondary keywords (not run in this script)
 *   - Tracks the secondary North York location in _meta for follow-up
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import dns from 'node:dns';
import { mkdir, writeFile } from 'node:fs/promises';

dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { generateGridCoordinates, type GridPoint } from '../lib/dataforseo/grid';
import {
  runLiveLocalPackScan,
  type LocalPackItem,
  type ScanPointResult,
} from '../lib/dataforseo/client';
import { getServerSupabase } from '../lib/supabase/server';
import { turfRadius } from '../lib/metrics/turfRadius';

// ─── Client fixture ────────────────────────────────────────────────────────
const CLIENT_ID = '00000000-0000-4000-a000-000000000003';
const CLIENT = {
  id: CLIENT_ID,
  business_name: 'Kidcrew Medical',
  // Flagship; secondary at 240 Duncan Mill Rd is queued in _meta.
  address: '1440 Bathurst Street, Toronto, ON M5R 3J3',
  latitude: 43.6822,
  longitude: -79.41834,
  industry: 'pediatric medical',
  status: 'active' as const,
  service_radius_miles: 25,
};
const CENTER_LABEL = 'Toronto, ON — Wychwood (Bathurst & St. Clair)';
const SECONDARY_LOCATION = {
  address: '240 Duncan Mill Road, Toronto, ON M3B 3S6',
  latitude: 43.76214,
  longitude: -79.35142,
  label: 'North York / Don Valley East',
};

const PRIMARY_KEYWORD = 'pediatrician';
const SECONDARY_KEYWORDS = [
  'child psychologist',
  'pediatric occupational therapist',
  'ADHD assessment',
  'psychoeducational assessment',
];

const OUT_OF_PACK = 20;

// Match the client business itself in local-pack listings. Catches
// "Kidcrew Medical", "Kidcrew Pediatric Medical Clinic", etc.
const KIDCREW_PATTERN = /kidcrew/i;

// ─── Brand-root patterns for franchise / multi-location collapse ───────────
// Canadian "paediatric" + US "pediatric" both accepted via [ae] class.
type BrandPattern = { name: string; pattern: RegExp };
const COMPETITORS: BrandPattern[] = [
  { name: 'Nest Health',                  pattern: /nest\s+health/i },
  { name: 'Medcan',                       pattern: /\bmedcan\b/i },
  { name: 'Cleveland Clinic Canada',      pattern: /cleveland\s+clinic/i },
  { name: 'Don Mills Pediatrics',         pattern: /don\s+mills\s+p[ae]diatric/i },
  { name: 'Toronto Beach Pediatrics',     pattern: /toronto\s+beach/i },
  { name: 'True North Health Centre',     pattern: /true\s+north\s+health/i },
  // Sickkids has many GBP listing variants — match all of them.
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function brandFor(item: LocalPackItem): string | null {
  const title = (item.title ?? '').toString();
  for (const c of COMPETITORS) {
    if (c.pattern.test(title)) return c.name;
  }
  return null;
}

function buildClientGrid(results: ScanPointResult[]): (number | null)[][] {
  const grid: (number | null)[][] = Array.from({ length: 9 }, () =>
    Array<number | null>(9).fill(null)
  );
  for (const r of results) {
    grid[r.point.y][r.point.x] = r.rank;
  }
  return grid;
}

function buildCompetitorLeaderboard(
  results: ScanPointResult[]
): Array<{ name: string; avg_rank: number; appears_in_cells: number }> {
  const ranksByBrand = new Map<string, number[]>();

  for (const r of results) {
    const cellBest = new Map<string, number>();
    for (const item of r.items) {
      const brand = brandFor(item);
      if (!brand) continue;
      const rank =
        typeof item.rank_group === 'number'
          ? item.rank_group
          : typeof item.rank_absolute === 'number'
            ? item.rank_absolute
            : null;
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

  return COMPETITORS.map(({ name }) => {
    const ranks = ranksByBrand.get(name) ?? [];
    if (ranks.length === 0) {
      return { name, avg_rank: OUT_OF_PACK, appears_in_cells: 0 };
    }
    const avg = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    return {
      name,
      avg_rank: round1(avg),
      appears_in_cells: ranks.length,
    };
  }).sort((a, b) => a.avg_rank - b.avg_rank);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const supabase = getServerSupabase();

  console.log('▸ Upserting client row…');
  {
    const { error } = await supabase.from('clients').upsert(CLIENT);
    if (error) throw new Error(`client upsert failed: ${error.message}`);
  }

  console.log('▸ Ensuring keywords exist (1 primary + 4 queued secondaries)…');
  let primaryKeywordId: string;
  {
    const { data: existing } = await supabase
      .from('tracked_keywords')
      .select('id, keyword, is_primary')
      .eq('client_id', CLIENT_ID);

    const existingMap = new Map(
      (existing ?? []).map((k) => [k.keyword.toLowerCase(), k.id as string])
    );

    const primaryExisting = existingMap.get(PRIMARY_KEYWORD);
    if (primaryExisting) {
      primaryKeywordId = primaryExisting;
    } else {
      const { data, error } = await supabase
        .from('tracked_keywords')
        .insert({
          client_id: CLIENT_ID,
          keyword: PRIMARY_KEYWORD,
          is_primary: true,
        })
        .select('id')
        .single();
      if (error) throw new Error(`primary keyword insert failed: ${error.message}`);
      primaryKeywordId = data.id;
    }

    for (const kw of SECONDARY_KEYWORDS) {
      if (existingMap.has(kw.toLowerCase())) continue;
      const { error } = await supabase.from('tracked_keywords').insert({
        client_id: CLIENT_ID,
        keyword: kw,
        is_primary: false,
      });
      if (error && !String(error.code).includes('23505')) {
        throw new Error(`secondary keyword insert failed: ${error.message}`);
      }
    }
  }

  console.log('▸ Creating scan row…');
  const { data: scanRow, error: scanErr } = await supabase
    .from('scans')
    .insert({
      client_id: CLIENT_ID,
      keyword_id: primaryKeywordId,
      scan_type: 'on_demand',
      grid_size: 9,
      status: 'running',
      total_points: 81,
    })
    .select('id')
    .single();
  if (scanErr || !scanRow) {
    throw new Error(`scan insert failed: ${scanErr?.message ?? 'no row'}`);
  }
  const scanId = scanRow.id;
  console.log(`  scan_id = ${scanId}`);

  const points: GridPoint[] = generateGridCoordinates({
    centerLat: CLIENT.latitude,
    centerLng: CLIENT.longitude,
    gridSize: 9,
    radiusMiles: CLIENT.service_radius_miles,
  });
  console.log(
    `▸ Generated ${points.length} grid points ` +
      `(spacing ${(CLIENT.service_radius_miles / 4).toFixed(2)} mi)`
  );

  console.log('▸ Running DFS Live scan for "pediatrician" (real cost incoming)…');
  const t0 = Date.now();
  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: PRIMARY_KEYWORD,
      points,
      targetMatch: (item) =>
        KIDCREW_PATTERN.test((item.title ?? '').toString()),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('  ✗ DFS scan failed:', msg);
    await supabase
      .from('scans')
      .update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', scanId);
    process.exit(1);
  }
  const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  ✓ Scan completed in ${dtSec}s — ` +
      `cost $${scan.dfsCostDollars.toFixed(4)} ` +
      `(${scan.dfsCostCents}¢), failed_points=${scan.failedPoints}`
  );

  console.log('▸ Writing scan_points…');
  {
    const rows = scan.results.map((r) => ({
      scan_id: scanId,
      grid_x: r.point.x,
      grid_y: r.point.y,
      latitude: r.point.lat,
      longitude: r.point.lng,
      rank: r.rank,
      business_found: r.businessFound,
      competitors: r.items.slice(0, 3).map((it) => ({
        name: it.title ?? null,
        domain: it.domain ?? null,
        rank_group: it.rank_group ?? null,
        rank_absolute: it.rank_absolute ?? null,
        place_id: it.place_id ?? null,
      })),
      raw_response: r.raw,
    }));
    const { error } = await supabase.from('scan_points').insert(rows);
    if (error) throw new Error(`scan_points insert failed: ${error.message}`);
  }

  // ─── Compute summary metrics that the dashboard + AI Coach read ─────────
  const ranksFlat = scan.results.map((r) => r.rank);
  const inPackCount = ranksFlat.filter((r): r is number => r !== null).length;

  const avgRankCapped =
    ranksFlat.reduce<number>(
      (sum, r) => sum + (r === null ? OUT_OF_PACK : r),
      0
    ) / ranksFlat.length;

  const pctTop3 = Math.round((inPackCount / ranksFlat.length) * 100);
  const pctTop10 = pctTop3;
  const pctTop20 = pctTop3;
  const turfscore = round1(100 - 5 * avgRankCapped);
  const radiusUnits = turfRadius(
    scan.results.map((r) => ({
      point: { x: r.point.x, y: r.point.y },
      rank: r.rank,
    })),
    9,
    OUT_OF_PACK
  );

  console.log('▸ Updating scan row to complete (with computed metrics)…');
  {
    const { error } = await supabase
      .from('scans')
      .update({
        status: 'complete',
        dfs_cost_cents: scan.dfsCostCents,
        failed_points: scan.failedPoints,
        total_points: scan.results.length,
        completed_at: new Date().toISOString(),
        // These three are what the AI Coach + dashboard SQL fallbacks read.
        // Without them the AI thinks the client has 0% presence.
        turf_score: round1(avgRankCapped),
        top3_win_rate: pctTop3,
        turf_radius_units: radiusUnits,
      })
      .eq('id', scanId);
    if (error) throw new Error(`scan update failed: ${error.message}`);
  }

  // ─── Build pitch-deck JSON ───────────────────────────────────────────────
  const kidcrewGrid = buildClientGrid(scan.results);

  const competitors = buildCompetitorLeaderboard(scan.results);

  const kidcrewLeaderboardRow = {
    name: CLIENT.business_name,
    avg_rank: round1(avgRankCapped),
    appears_in_cells: inPackCount,
  };
  const fullLeaderboard = [...competitors, kidcrewLeaderboardRow].sort(
    (a, b) => a.avg_rank - b.avg_rank
  );
  const kidcrewPosition =
    fullLeaderboard.findIndex((row) => row.name === kidcrewLeaderboardRow.name) + 1;

  const output = {
    client: CLIENT.business_name,
    keyword: PRIMARY_KEYWORD,
    scan_date: new Date().toISOString().slice(0, 10),
    center: {
      lat: CLIENT.latitude,
      lng: CLIENT.longitude,
      label: CENTER_LABEL,
    },
    radius_miles: CLIENT.service_radius_miles,
    turfscore,
    avg_rank: round1(avgRankCapped),
    pct_top_3: pctTop3,
    pct_top_10: pctTop10,
    pct_top_20: pctTop20,
    grid: kidcrewGrid,
    competitors,
    client_rank_per_cell: kidcrewGrid,
    cost_cents: scan.dfsCostCents,
    _meta: {
      scan_id: scanId,
      grid_size: 9,
      grid_spacing_miles: round1(CLIENT.service_radius_miles / 4),
      dfs_endpoint: '/v3/serp/google/organic/live/advanced',
      failed_points: scan.failedPoints,
      kidcrew_match_pattern: KIDCREW_PATTERN.source,
      kidcrew_leaderboard_position: kidcrewPosition,
      kidcrew_in_leaderboard: kidcrewLeaderboardRow,
      followup_scan_address: SECONDARY_LOCATION,
      queued_secondary_keywords: SECONDARY_KEYWORDS,
      note_visibility_metrics:
        'pct_top_10 and pct_top_20 equal pct_top_3 because local-pack data ' +
        'only returns ranks 1-3.',
      note_pitch_framing:
        "Sickkids is included in the leaderboard for baseline reference, " +
        "not as a competitive comparison — the meaningful pitch story " +
        "compares Kidcrew against private clinics (Nest, Medcan, Don Mills, " +
        "Bloorkids, Kindercare, Midtown, Everest, Roundhouse).",
    },
  };

  const outDir = path.resolve(process.cwd(), 'outputs');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'kidcrew-medical-pediatrician-scan.json');
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`▸ Wrote ${outPath}`);

  // ─── Console summary ─────────────────────────────────────────────────────
  const winner = competitors[0];
  const winnerLabel =
    winner && winner.appears_in_cells > 0
      ? `${winner.name} — avg rank ${winner.avg_rank}, in ${winner.appears_in_cells}/81 cells`
      : '(no tracked competitor surfaced in local pack)';

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${CLIENT.business_name} — TurfMap scan summary`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  keyword            : "${PRIMARY_KEYWORD}"`);
  console.log(`  center             : ${CENTER_LABEL}`);
  console.log(
    `  grid               : 9x9, ${CLIENT.service_radius_miles}-mi axis radius`
  );
  console.log(`  TurfScore          : ${turfscore} / 100`);
  console.log(`  avg rank (capped)  : ${round1(avgRankCapped)}`);
  console.log(`  in 3-pack          : ${inPackCount} / 81 cells (${pctTop3}%)`);
  console.log(`  pct top 3 / 10 / 20: ${pctTop3}% / ${pctTop10}% / ${pctTop20}%`);
  console.log(`  leaderboard #1     : ${winnerLabel}`);
  console.log(
    `  Kidcrew position   : ${
      kidcrewPosition > 0 ? `#${kidcrewPosition} of ${fullLeaderboard.length}` : 'unranked'
    }`
  );
  console.log(
    `  DFS cost (USD)     : $${scan.dfsCostDollars.toFixed(4)} (${scan.dfsCostCents}¢)`
  );
  console.log(`  failed points      : ${scan.failedPoints}`);
  console.log(`  output             : outputs/kidcrew-medical-pediatrician-scan.json`);
  console.log(`  scan_id            : ${scanId}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  Top of leaderboard:');
  for (const c of competitors.slice(0, 8)) {
    const tag =
      c.appears_in_cells === 0 ? '— not in local pack' : `${c.appears_in_cells} cells`;
    console.log(
      `    avg ${String(c.avg_rank).padStart(4)}  ${c.name.padEnd(34)} ${tag}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
