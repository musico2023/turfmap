/**
 * Phase 1 verification script.
 *
 * Runs a real DataForSEO Local Pack Live scan against a hardcoded Toronto
 * plumber across an 81-point grid, persists everything to Supabase, and
 * prints a cost / status summary so we can confirm `dfs_cost_cents` matches
 * what DFS actually billed.
 *
 * Run with:  npm run test-scan
 *
 * Idempotent: uses a fixed UUID for the test client so repeated runs reuse
 * the same client + keyword and just append a new scan.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import dns from 'node:dns';
// On dual-stack networks Node sometimes prefers an AAAA lookup that fails
// transiently against api.dataforseo.com (which only publishes A records).
// Force IPv4-first DNS resolution to avoid ENOTFOUND flakes.
dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { generateGridCoordinates } from '../lib/dataforseo/grid';
import {
  runLiveLocalPackScan,
  type LocalPackItem,
} from '../lib/dataforseo/client';
import { getServerSupabase } from '../lib/supabase/server';

// ─── Test fixture ──────────────────────────────────────────────────────────
const TEST_CLIENT_ID = '00000000-0000-4000-a000-000000000001';
const TEST_CLIENT = {
  id: TEST_CLIENT_ID,
  business_name: 'Mr. Rooter Plumbing of Toronto',
  address: '100 Queen St W, Toronto, ON M5H 2N2, Canada',
  latitude: 43.6532,
  longitude: -79.3832,
  industry: 'plumbing',
  status: 'active' as const,
  service_radius_miles: 1.6,
};
const TEST_KEYWORD = 'plumber';

async function main() {
  const supabase = getServerSupabase();

  // 1. Upsert client (idempotent on fixed UUID)
  console.log('▸ Upserting test client…');
  {
    const { error } = await supabase.from('clients').upsert(TEST_CLIENT);
    if (error) throw new Error(`client upsert failed: ${error.message}`);
  }

  // 2. Find or create tracked_keyword
  console.log('▸ Ensuring tracked keyword exists…');
  let keywordId: string;
  {
    const { data: existing, error: selErr } = await supabase
      .from('tracked_keywords')
      .select('id')
      .eq('client_id', TEST_CLIENT_ID)
      .eq('keyword', TEST_KEYWORD)
      .maybeSingle();
    if (selErr) throw new Error(`keyword lookup failed: ${selErr.message}`);

    if (existing) {
      keywordId = existing.id;
    } else {
      const { data, error } = await supabase
        .from('tracked_keywords')
        .insert({
          client_id: TEST_CLIENT_ID,
          keyword: TEST_KEYWORD,
          is_primary: true,
        })
        .select('id')
        .single();
      if (error) throw new Error(`keyword insert failed: ${error.message}`);
      keywordId = data.id;
    }
  }

  // 3. Create scan row in 'running' status
  console.log('▸ Creating scan row…');
  const { data: scanRow, error: scanErr } = await supabase
    .from('scans')
    .insert({
      client_id: TEST_CLIENT_ID,
      keyword_id: keywordId,
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

  // 4. Generate the 81-point grid
  const points = generateGridCoordinates({
    centerLat: TEST_CLIENT.latitude,
    centerLng: TEST_CLIENT.longitude,
    gridSize: 9,
    radiusMiles: TEST_CLIENT.service_radius_miles,
  });
  console.log(`▸ Generated ${points.length} grid points`);

  // 5. Match function: substring on the business name (case-insensitive).
  //    Loose by design — we just want to demonstrate rank capture.
  const targetMatch = (item: LocalPackItem): boolean => {
    const title = (item.title ?? '').toString().toLowerCase();
    return title.includes('rooter');
  };

  // 6. Run the live scan
  console.log('▸ Running DFS Live Local Pack scan (this costs real money)…');
  const t0 = Date.now();
  let scan;
  try {
    scan = await runLiveLocalPackScan({
      keyword: TEST_KEYWORD,
      points,
      targetMatch,
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

  // 7. Insert scan_points (batch). Trim raw_response slightly to keep rows small.
  console.log('▸ Writing scan_points…');
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
  {
    const { error } = await supabase.from('scan_points').insert(rows);
    if (error) throw new Error(`scan_points insert failed: ${error.message}`);
  }

  // 8. Mark scan complete with cost + counts
  const found = scan.results.filter((r) => r.businessFound).length;
  console.log('▸ Updating scan row…');
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

  // 9. Summary
  const ranks = scan.results.map((r) => r.rank);
  const ranked = ranks.filter((r): r is number => r !== null);
  const top3 = ranked.length;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Phase 1 test scan complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  client          : ${TEST_CLIENT.business_name}`);
  console.log(`  keyword         : "${TEST_KEYWORD}"`);
  console.log(`  scan_id         : ${scanId}`);
  console.log(`  grid points     : ${scan.results.length}`);
  console.log(`  failed points   : ${scan.failedPoints}`);
  console.log(`  business found  : ${found} / ${scan.results.length} points`);
  console.log(`  in top-3 anywhere: ${top3} / ${scan.results.length} points`);
  console.log(`  DFS cost (USD)  : $${scan.dfsCostDollars.toFixed(4)}`);
  console.log(`  dfs_cost_cents  : ${scan.dfsCostCents}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Verify in Supabase:');
  console.log(
    `  https://supabase.com/dashboard/project/${
      (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').match(/https:\/\/([^.]+)\./)?.[1]
    }/editor`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
