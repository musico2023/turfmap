/**
 * Real-client scan: Ivy's Touch Home Healthcare LLC (Alexandria, VA).
 *
 * First production scan run from a sales-pitch context.
 *
 * Run with:  npm run scan:ivys-touch
 *
 *   1. Upsert client row in Supabase (idempotent on fixed UUID).
 *   2. Insert primary keyword ("home care") + 5 secondaries (queued only).
 *   3. Create scan row in 'running' status.
 *   4. Generate 81-point 9x9 grid at 25-mile radius (≈6.25mi spacing).
 *   5. Run Live Local Pack scan via lib/dataforseo/client.
 *   6. Persist scan_points + cost_cents.
 *   7. Build pitch-deck JSON at outputs/ivys-touch-home-care-scan.json:
 *        - 9x9 client rank grid (null = not in top 3-pack at that cell)
 *        - Brand-collapsed competitor leaderboard
 *        - TurfScore = 100 - 5 * avg_rank_capped_at_20
 *   8. Print console summary.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import dns from 'node:dns';
import { mkdir, writeFile } from 'node:fs/promises';

// Force IPv4-first DNS (api.dataforseo.com only publishes A records;
// dual-stack networks sometimes flake on AAAA).
dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { generateGridCoordinates, type GridPoint } from '../lib/dataforseo/grid';
import {
  runLiveLocalPackScan,
  type LocalPackItem,
  type ScanPointResult,
} from '../lib/dataforseo/client';
import { getServerSupabase } from '../lib/supabase/server';

// ─── Client fixture ────────────────────────────────────────────────────────
const CLIENT_ID = '00000000-0000-4000-a000-000000000002';
const CLIENT = {
  id: CLIENT_ID,
  business_name: "Ivy's Touch Home Healthcare LLC",
  address: '5904 Richmond Hwy, Ste 518, Alexandria, VA 22303',
  latitude: 38.78,
  longitude: -77.08,
  industry: 'home healthcare',
  status: 'active' as const,
  service_radius_miles: 25,
};
const CENTER_LABEL = 'Alexandria, VA — Hybla Valley';

const PRIMARY_KEYWORD = 'home care';
const SECONDARY_KEYWORDS = [
  'home health care',
  'in home senior care',
  'elder care near me',
  'live in caregiver',
];

const OUT_OF_PACK = 20;

// Fuzzy match for the client business itself across local-pack listings.
// Catches "Ivy's Touch", "Ivys Touch Home Healthcare", "Ivy's Touch Home Care", etc.
const IVYS_TOUCH_PATTERN = /ivy.{0,3}touch/i;

// ─── Brand-root patterns for franchise / multi-location collapse ───────────
// Order matters: longer / more-specific patterns first so multi-word brands
// don't get partial-matched by a shorter pattern (none collide here, but
// keeping the convention for safety).
type BrandPattern = { name: string; pattern: RegExp };
const COMPETITORS: BrandPattern[] = [
  { name: 'Home Instead',            pattern: /home\s*instead/i },
  { name: 'Comfort Keepers',         pattern: /comfort\s*keepers/i },
  { name: 'Visiting Angels',         pattern: /visiting\s*angels/i },
  { name: 'IncrediCare',             pattern: /incredi[-\s]*care/i },
  { name: 'Right at Home',           pattern: /right\s+at\s+home/i },
  { name: 'BrightStar Care',         pattern: /bright\s*star\s*care/i },
  { name: 'Always Best Care',        pattern: /always\s+best\s+care/i },
  { name: 'Apollo Home Healthcare',  pattern: /apollo\s+home\s*healthcare?/i },
  { name: 'Senior Helpers',          pattern: /senior\s*helpers?/i },
  { name: 'Caring Senior Service',   pattern: /caring\s+senior\s+service/i },
  { name: 'Edna Home Care Services', pattern: /edna\s+home\s+care/i },
  { name: 'Ajir Home Care',          pattern: /ajir\s+home\s+care/i },
  { name: 'Mint Caregivers',         pattern: /mint\s+caregivers?/i },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Find which competitor brand a local-pack item belongs to, if any. */
function brandFor(item: LocalPackItem): string | null {
  const title = (item.title ?? '').toString();
  for (const c of COMPETITORS) {
    if (c.pattern.test(title)) return c.name;
  }
  return null;
}

/**
 * Build a 9x9 grid of Ivy's Touch ranks, indexed grid[y][x]
 * (y=0 → northernmost row, matching how generateGridCoordinates lays out
 * points). null means not in top 3-pack at that cell.
 */
function buildClientGrid(results: ScanPointResult[]): (number | null)[][] {
  const grid: (number | null)[][] = Array.from({ length: 9 }, () =>
    Array<number | null>(9).fill(null)
  );
  for (const r of results) {
    grid[r.point.y][r.point.x] = r.rank;
  }
  return grid;
}

/**
 * Collapse multi-location franchises and compute (avg_rank, appears_in_cells)
 * per brand. A brand "appears in" a cell if at least one of its locations
 * shows up in that cell's local 3-pack; rank is the BEST (lowest) of any
 * locations present in that cell.
 *
 * Brands not in COMPETITORS are ignored entirely (not surfaced in leaderboard).
 */
function buildCompetitorLeaderboard(
  results: ScanPointResult[]
): Array<{ name: string; avg_rank: number; appears_in_cells: number }> {
  // brand → array of best-rank-per-cell
  const ranksByBrand = new Map<string, number[]>();

  for (const r of results) {
    // best rank per brand within this single cell
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
      if (rank === null || rank > 3) continue; // local pack only goes 1-3
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

  // 1. Upsert client (idempotent)
  console.log('▸ Upserting client row…');
  {
    const { error } = await supabase.from('clients').upsert(CLIENT);
    if (error) throw new Error(`client upsert failed: ${error.message}`);
  }

  // 2. Ensure primary + queued secondary keywords exist
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

    // primary
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

    // secondaries (queued, is_primary=false, no scan run for these)
    for (const kw of SECONDARY_KEYWORDS) {
      if (existingMap.has(kw.toLowerCase())) continue;
      const { error } = await supabase.from('tracked_keywords').insert({
        client_id: CLIENT_ID,
        keyword: kw,
        is_primary: false,
      });
      if (error) {
        // 23505 = unique violation; fine, just skip
        if (!String(error.code).includes('23505')) {
          throw new Error(`secondary keyword insert failed: ${error.message}`);
        }
      }
    }
  }

  // 3. Create scan row
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

  // 4. Generate grid (25-mi axis radius → 6.25mi spacing on 9x9)
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

  // 5. Run scan (real money)
  console.log('▸ Running DFS Live scan for "home care" (real cost incoming)…');
  const t0 = Date.now();
  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: PRIMARY_KEYWORD,
      points,
      targetMatch: (item) =>
        IVYS_TOUCH_PATTERN.test((item.title ?? '').toString()),
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

  // 6. Persist scan_points
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

  // 7. Mark scan complete
  console.log('▸ Updating scan row to complete…');
  {
    const { error } = await supabase
      .from('scans')
      .update({
        status: 'complete',
        dfs_cost_cents: scan.dfsCostCents,
        failed_points: scan.failedPoints,
        total_points: scan.results.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', scanId);
    if (error) throw new Error(`scan update failed: ${error.message}`);
  }

  // 8. Build pitch-deck JSON
  const ivysGrid = buildClientGrid(scan.results);
  const ranksFlat = scan.results.map((r) => r.rank);
  const inPackCount = ranksFlat.filter((r): r is number => r !== null).length;

  // Average rank w/ out-of-pack penalty
  const avgRankCapped =
    ranksFlat.reduce<number>(
      (sum, r) => sum + (r === null ? OUT_OF_PACK : r),
      0
    ) / ranksFlat.length;

  // Visibility metrics. Local-pack data only gives ranks 1-3, so
  // pct_top_10 and pct_top_20 are mathematically equal to pct_top_3
  // (a rank ≤ 3 is trivially also ≤ 10 and ≤ 20). For broader visibility
  // depth we'd need to also query organic results — out of scope for v1.
  const pctTop3 = Math.round((inPackCount / ranksFlat.length) * 100);
  const pctTop10 = pctTop3;
  const pctTop20 = pctTop3;

  const turfscore = round1(100 - 5 * avgRankCapped);

  const competitors = buildCompetitorLeaderboard(scan.results);

  // Where does Ivy's Touch land in the leaderboard if we include them?
  const ivysLeaderboardRow = {
    name: "Ivy's Touch Home Healthcare LLC",
    avg_rank: round1(avgRankCapped),
    appears_in_cells: inPackCount,
  };
  const fullLeaderboard = [...competitors, ivysLeaderboardRow].sort(
    (a, b) => a.avg_rank - b.avg_rank
  );
  const ivysPosition =
    fullLeaderboard.findIndex((row) => row.name === ivysLeaderboardRow.name) + 1;

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
    grid: ivysGrid,
    competitors, // primary leaderboard (the 13 brands)
    client_rank_per_cell: ivysGrid, // duplicate per spec
    cost_cents: scan.dfsCostCents,
    // ── extras for pitch-deck convenience ──
    _meta: {
      scan_id: scanId,
      grid_size: 9,
      grid_spacing_miles: round1(CLIENT.service_radius_miles / 4),
      dfs_endpoint: '/v3/serp/google/organic/live/advanced',
      failed_points: scan.failedPoints,
      ivys_touch_match_pattern: IVYS_TOUCH_PATTERN.source,
      ivys_touch_leaderboard_position: ivysPosition,
      ivys_touch_in_leaderboard: ivysLeaderboardRow,
      note_visibility_metrics:
        'pct_top_10 and pct_top_20 equal pct_top_3 because local-pack data ' +
        'only returns ranks 1-3. For deeper rank tracking, query organic SERP.',
    },
  };

  // 9. Write file
  const outDir = path.resolve(process.cwd(), 'outputs');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ivys-touch-home-care-scan.json');
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`▸ Wrote ${outPath}`);

  // 10. Console summary
  const winner = competitors[0]; // already sorted by avg_rank ascending
  const winnerLabel =
    winner && winner.appears_in_cells > 0
      ? `${winner.name} — avg rank ${winner.avg_rank}, in ${winner.appears_in_cells}/81 cells`
      : '(no tracked competitor surfaced in local pack)';

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log("  Ivy's Touch — TurfMap scan summary");
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
    `  Ivy's Touch position : ${
      ivysPosition > 0 ? `#${ivysPosition} of ${fullLeaderboard.length}` : 'unranked'
    }`
  );
  console.log(
    `  DFS cost (USD)     : $${scan.dfsCostDollars.toFixed(4)} (${scan.dfsCostCents}¢)`
  );
  console.log(`  failed points      : ${scan.failedPoints}`);
  console.log(`  output             : outputs/ivys-touch-home-care-scan.json`);
  console.log(`  scan_id            : ${scanId}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  Top of leaderboard:');
  for (const c of competitors.slice(0, 5)) {
    const tag =
      c.appears_in_cells === 0 ? '— not in local pack' : `${c.appears_in_cells} cells`;
    console.log(
      `    avg ${String(c.avg_rank).padStart(4)}  ${c.name.padEnd(28)} ${tag}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
