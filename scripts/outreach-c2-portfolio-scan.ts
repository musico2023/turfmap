/**
 * outreach-c2-portfolio-scan.ts — C2 PE-portfolio TurfScan (2026-08-27,
 * Anthony-approved: "run the portfolio scans and use real numbers").
 *
 * Stages 2-3 of the WS13 task: for each of the 16 roll-up platforms in
 * 01-lists/c2/c2-brands.csv (Frontdoor/Cobalt/Sentinel already excluded
 * upstream), resolve up to 12 sampled brand locations via Google Places
 * Text Search (brand name only, US-biased — spread across brands, round-
 * robin so no single brand dominates the sample), then run the SAME
 * production 81-point-grid scan pipeline as the C1 batches, with a
 * per-platform/per-brand keyword (verbatim rules baked in below, per the
 * coordinator's explicit mapping — no auto-derivation).
 *
 * Budget: hard cap = live DFS balance - $2 buffer. If total demand
 * (platforms-with-brands x 12) would exceed the affordable scan count,
 * the per-platform sample cap is trimmed evenly (floor(12 * cap/demand))
 * BEFORE any spend, rather than exhausting budget on the first platforms
 * processed and leaving later ones at zero.
 *
 * Output: 02-turfscan/c2-portfolio-rollup.csv (one row per platform) +
 * 02-turfscan/c2-portfolio-locations.csv (one row per sampled location —
 * the per-location detail file). Resume-safe via a location-level
 * progress file; orphan-guard kept (same pattern as outreach-c1-rescan.ts).
 *
 * Run: npx tsx scripts/outreach-c2-portfolio-scan.ts [--cap 32.70] [--dry-run]
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { searchPlaces, getPlaceDetails } from '../lib/google/places';
import { runScanForLocation } from '../lib/scans/runScan';
import type { ClientRow, ClientLocationRow, TrackedKeywordRow } from '../lib/supabase/types';
import { normalizeIndustry } from '../lib/industries/normalize';

const OUTREACH_ROOT = path.resolve(process.cwd(), '../fourdots-outreach');
const BRANDS_CSV = path.join(OUTREACH_ROOT, '01-lists/c2/c2-brands.csv');
const RESULTS_DIR = path.join(OUTREACH_ROOT, '02-turfscan');
const LOCATIONS_PATH = path.join(RESULTS_DIR, 'c2-portfolio-locations.csv');
const ROLLUP_PATH = path.join(RESULTS_DIR, 'c2-portfolio-rollup.csv');
const PROGRESS_PATH = path.join(RESULTS_DIR, '_c2-portfolio-progress.csv');
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

const DEFAULT_SHARE_DAYS = 90;
const SHARE_CTA_TEXT = 'See your full territory map';
const SHARE_CTA_URL = 'https://localleadmachine.io/';
const SAMPLE_CAP = 12;
const COST_PER_SCAN_ESTIMATE = 0.162;

// ─── explicit per-platform keyword rules (verbatim per coordinator) ────
const FIXED_PLATFORM_KEYWORD: Record<string, string> = {
  Greenix: 'pest control near me',
  'Leaf Home': 'gutter installation near me',
  'Canopy Service Partners': 'tree service near me',
  'Guardian Restoration Partners': 'water damage restoration near me',
  'Mosaic Service Partners': 'window replacement near me',
  'Vertex Service Partners': 'roofing contractor near me',
  'Renovo Home Partners': 'bathroom remodeling near me',
};

/** HVAC/plumbing/electrical roll-up platforms: match the brand's evident
 *  trade from its name; default to "hvac company near me" otherwise. */
function keywordForHvacPlatformBrand(brand: string): string {
  if (/plumb/i.test(brand)) return 'plumber near me';
  if (/electric/i.test(brand)) return 'electrician near me';
  return 'hvac company near me';
}

function keywordFor(platform: string, brand: string): string {
  if (FIXED_PLATFORM_KEYWORD[platform]) return FIXED_PLATFORM_KEYWORD[platform];
  return keywordForHvacPlatformBrand(brand);
}

/** Trade-disambiguating phrase appended to the Places search QUERY (not
 *  the scan keyword) for every platform. Verified live: a bare single-
 *  word brand like "Elite" or "Sierra" pulls in unrelated local
 *  businesses (property managers, spas, clinics); appending the trade
 *  context collapses the results back down to genuinely matching HVAC/
 *  plumbing/electrical/etc. businesses almost perfectly. */
const PLATFORM_TRADE_HINT: Record<string, string> = {
  Greenix: 'pest control',
  'Leaf Home': 'gutters',
  'Canopy Service Partners': 'tree service',
  'Guardian Restoration Partners': 'restoration',
  'Mosaic Service Partners': 'windows doors',
  'Vertex Service Partners': 'roofing',
  'Renovo Home Partners': 'remodeling',
};
function tradeHintFor(platform: string): string {
  return PLATFORM_TRADE_HINT[platform] ?? 'heating cooling plumbing electrical';
}

// ─── CSV helpers ───────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function csvField(s: unknown): string {
  const str = s === null || s === undefined ? '' : String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Brand-match plausibility filter ──────────────────────────────────
// Generic-sounding brand queries ("Leaf Home", "Elite", "Pioneer" …) pull
// in unrelated real businesses via plain text search (verified live:
// "Leaf Home" matched "Maple Leaf House Grill & Lounge" and "MAPLE LEAF
// Staffing" among real results). Filter with (a) token-jaccard similarity
// and (b) a primaryType exclusion list for obviously wrong categories —
// imperfect (documented in the report), but removes the worst false
// positives cheaply.
const NAME_NOISE = new Set(['inc', 'llc', 'ltd', 'limited', 'corp', 'co', 'company', 'group', 'the', 'and', '&']);
function jaccard(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !NAME_NOISE.has(t)));
  const A = tokenize(a), B = tokenize(b);
  if (A.size === 0 || B.size === 0) return a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()) ? 1 : 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
const IMPLAUSIBLE_TYPES = new Set([
  'restaurant', 'bar', 'cafe', 'food', 'bakery', 'meal_takeaway', 'meal_delivery',
  'store', 'clothing_store', 'florist', 'grocery_store', 'convenience_store',
  'employment_agency', 'real_estate_agency', 'lodging', 'hotel', 'school',
  'place_of_worship', 'gym', 'beauty_salon', 'hair_care', 'bank', 'atm',
  'night_club', 'movie_theater', 'museum', 'park', 'tourist_attraction',
]);
function isPlausibleMatch(brand: string, displayName: string | null, primaryType: string | null): boolean {
  if (!displayName) return false;
  const sim = jaccard(brand, displayName);
  const exactish = displayName.toLowerCase().includes(brand.toLowerCase());
  if (!exactish && sim < 0.6) return false;
  if (primaryType && IMPLAUSIBLE_TYPES.has(primaryType)) return false;
  return true;
}

// ─── Load brand list, grouped by platform ─────────────────────────────
function readBrands(): Map<string, string[]> {
  const raw = fs.readFileSync(BRANDS_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const pIdx = header.indexOf('platform');
  const bIdx = header.indexOf('brand');
  const map = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const platform = c[pIdx] ?? '';
    const brand = (c[bIdx] ?? '').trim();
    if (!map.has(platform)) map.set(platform, []);
    if (brand) map.get(platform)!.push(brand);
  }
  return map;
}

// ─── DFS balance probe (free) ─────────────────────────────────────────
async function fetchDfsBalance(): Promise<number | null> {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) return null;
  const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
    method: 'GET',
    headers: { Authorization: auth },
  });
  if (!res.ok) return null;
  const json = await res.json();
  try {
    return json.tasks[0].result[0].money.balance as number;
  } catch {
    return null;
  }
}

// ─── Location sampling: round-robin across brands, up to `cap` total ──
type SampleLoc = {
  platform: string; brand: string; placeId: string; matchedName: string | null;
  matchedAddress: string | null; lat: number; lng: number;
};

async function sampleLocationsForPlatform(platform: string, brands: string[], cap: number): Promise<SampleLoc[]> {
  // Depth per brand scales with how few brands there are — a single-brand
  // platform (Leaf Home, Greenix) needs up to `cap` distinct locations
  // from ONE query; a 20+-brand platform only needs 1-2 each.
  const perBrandDepth = Math.min(10, Math.max(2, Math.ceil((cap * 1.5) / brands.length)));
  const maxRounds = Math.max(2, Math.ceil(cap / brands.length) + 1);

  const pools = new Map<string, SampleLoc[]>();
  for (const brand of brands) {
    const searchQuery = `${brand} ${tradeHintFor(platform)}`;
    const search = await searchPlaces({ query: searchQuery, latitude: null, longitude: null, maxResults: perBrandDepth, regionCode: 'US' });
    const pool: SampleLoc[] = [];
    for (const cand of search.candidates.slice(0, perBrandDepth)) {
      const details = await getPlaceDetails(cand.placeId);
      if (!details || details.latitude === null || details.longitude === null) continue;
      if (!isPlausibleMatch(brand, details.displayName, details.primaryType)) continue;
      pool.push({
        platform, brand, placeId: details.placeId, matchedName: details.displayName,
        matchedAddress: details.formattedAddress, lat: details.latitude, lng: details.longitude,
      });
    }
    pools.set(brand, pool);
  }
  // Round-robin across brands (up to perBrandDepth per brand, up to
  // maxRounds passes) until `cap` collected — spreads across brands
  // first, then digs deeper into each brand's pool if still short.
  const out: SampleLoc[] = [];
  const seen = new Set<string>();
  let round = 0;
  while (out.length < cap && round < maxRounds) {
    let addedThisRound = false;
    for (const brand of brands) {
      if (out.length >= cap) break;
      const pool = pools.get(brand) ?? [];
      if (round < pool.length) {
        const loc = pool[round];
        if (!seen.has(loc.placeId)) {
          seen.add(loc.placeId);
          out.push(loc);
          addedThisRound = true;
        }
      }
    }
    round++;
    if (!addedThisRound) break;
  }
  return out;
}

// ─── Progress (resume-safe, keyed by place_id) ────────────────────────
function loadProgress(): Set<string> {
  const set = new Set<string>();
  if (!fs.existsSync(PROGRESS_PATH)) return set;
  const lines = fs.readFileSync(PROGRESS_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c[0]) set.add(c[0]);
  }
  return set;
}
function appendProgress(placeId: string) {
  const header = 'place_id\n';
  if (!fs.existsSync(PROGRESS_PATH)) fs.writeFileSync(PROGRESS_PATH, header);
  fs.appendFileSync(PROGRESS_PATH, `${csvField(placeId)}\n`);
}

// ─── Per-location detail CSV (append-only, incremental) ───────────────
const LOC_HEADER = 'platform,brand,matched_name,matched_address,category_keyword,turfscore,rank_at_pin,in_top3,absent,share_link,dfs_cost_usd,status,failure_reason';
function ensureLocationsCsv() {
  if (!fs.existsSync(LOCATIONS_PATH)) fs.writeFileSync(LOCATIONS_PATH, LOC_HEADER + '\n');
}
function appendLocationRow(row: {
  platform: string; brand: string; matched_name: string; matched_address: string;
  category_keyword: string; turfscore: number | string; rank_at_pin: number | string;
  in_top3: boolean | ''; absent: boolean; share_link: string; dfs_cost_usd: number;
  status: string; failure_reason: string;
}) {
  const line = [
    csvField(row.platform), csvField(row.brand), csvField(row.matched_name), csvField(row.matched_address),
    csvField(row.category_keyword), row.turfscore, row.rank_at_pin, row.in_top3, row.absent,
    csvField(row.share_link), row.dfs_cost_usd.toFixed(3), csvField(row.status), csvField(row.failure_reason),
  ].join(',');
  fs.appendFileSync(LOCATIONS_PATH, line + '\n');
}

// ─── Rollup (one row per platform, rewritten in full each update) ─────
function writeRollup(platformStats: Map<string, {
  nBrandsFound: number; nScanned: number; nWeak: number; nAbsent: number;
  worstCity: string; shareLinks: string[]; nFailed: number;
}>) {
  const header = 'platform,n_brands_found,n_scanned,n_failed,n_weak,n_absent,worst_city,share_link_examples';
  const lines = [header];
  for (const [platform, s] of platformStats) {
    lines.push([
      csvField(platform), s.nBrandsFound, s.nScanned, s.nFailed, s.nWeak, s.nAbsent, csvField(s.worstCity),
      csvField(s.shareLinks.slice(0, 3).join(' | ')),
    ].join(','));
  }
  fs.writeFileSync(ROLLUP_PATH, lines.join('\n') + '\n');
}

function extractCity(address: string | null): string {
  if (!address) return '';
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 3] || parts[0] || '';
  return parts[0] ?? '';
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const capIdx = args.indexOf('--cap');
  const dryRun = args.includes('--dry-run');

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  ensureLocationsCsv();

  let cap: number;
  if (capIdx !== -1) {
    cap = Number(args[capIdx + 1]);
  } else {
    const balance = await fetchDfsBalance();
    cap = balance !== null ? Math.max(0, balance - 2) : 10;
    console.log(`[c2-portfolio] live DFS balance = ${balance !== null ? '$' + balance.toFixed(2) : 'unknown'} -> effective cap = $${cap.toFixed(2)}`);
  }

  const brandsByPlatform = readBrands();
  const platforms = [...brandsByPlatform.keys()];
  const demand = platforms.reduce((n, p) => n + Math.min(brandsByPlatform.get(p)!.length > 0 ? SAMPLE_CAP : 0, SAMPLE_CAP), 0);
  const affordable = Math.floor(cap / COST_PER_SCAN_ESTIMATE);
  const perPlatformCap = demand > affordable ? Math.max(1, Math.floor((SAMPLE_CAP * affordable) / demand)) : SAMPLE_CAP;
  console.log(`[c2-portfolio] ${platforms.length} platforms, demand=${demand} @ cap ${SAMPLE_CAP}/platform, affordable=${affordable} scans -> per-platform cap this run = ${perPlatformCap}`);

  const supabase = getServerSupabase();
  const progress = loadProgress();
  let cumulative = 0;
  let stopReason = '';

  const platformStats = new Map<string, { nBrandsFound: number; nScanned: number; nFailed: number; nWeak: number; nAbsent: number; worstCity: string; shareLinks: string[]; worstRank: number }>();

  outer:
  for (const platform of platforms) {
    const brands = brandsByPlatform.get(platform)!;
    const stats = { nBrandsFound: brands.length, nScanned: 0, nFailed: 0, nWeak: 0, nAbsent: 0, worstCity: '', shareLinks: [] as string[], worstRank: -1 };
    platformStats.set(platform, stats);

    if (brands.length === 0) {
      console.log(`\n[c2-portfolio] === ${platform}: 0 brands known, skipping (no locations to sample) ===`);
      writeRollup(new Map([...platformStats].map(([p, s]) => [p, s])));
      continue;
    }

    console.log(`\n[c2-portfolio] === ${platform}: ${brands.length} brands known, sampling up to ${perPlatformCap} locations ===`);
    if (dryRun) {
      const n = Math.min(perPlatformCap, brands.length * 2);
      stats.nScanned = n;
      cumulative += n * COST_PER_SCAN_ESTIMATE;
      console.log(`  (dry-run) would sample+scan ~${n} locations — cumulative would become $${cumulative.toFixed(3)}`);
      continue;
    }

    const samples = await sampleLocationsForPlatform(platform, brands, perPlatformCap);
    console.log(`  resolved ${samples.length} sampled locations via Places`);

    for (const loc of samples) {
      if (progress.has(loc.placeId)) {
        continue; // already scanned in a prior run of this script
      }
      if (cumulative + COST_PER_SCAN_ESTIMATE > cap) {
        stopReason = `budget cap reached ($${cap.toFixed(2)}) mid-platform at ${platform} / ${loc.brand} (cumulative=$${cumulative.toFixed(3)})`;
        break outer;
      }

      const keyword = keywordFor(platform, loc.brand);
      const email = `outreach-c2+${slugify(platform)}-${slugify(loc.brand)}-${loc.placeId.slice(-6)}@fourdots-outreach.local`;
      console.log(`  [${platform} / ${loc.brand}] ${loc.matchedName} — keyword "${keyword}"`);

      // Orphan-guard: reuse only if a complete scan already exists for this exact client/keyword.
      const { data: existingClientRaw } = await supabase
        .from('clients').select('id').eq('is_outreach_lead', true).eq('pending_buyer_email', email).maybeSingle<{ id: string }>();
      let clientId: string | null = null;
      let dfsCostThisRow = 0;
      if (existingClientRaw) {
        const { data: scanWithKw } = await supabase
          .from('scans').select('id, keyword_id').eq('client_id', existingClientRaw.id).eq('status', 'complete')
          .order('created_at', { ascending: false }).limit(1).maybeSingle<{ id: string; keyword_id: string }>();
        let matches = false;
        if (scanWithKw) {
          const { data: kwRow } = await supabase.from('tracked_keywords').select('keyword').eq('id', scanWithKw.keyword_id).maybeSingle<{ keyword: string }>();
          matches = (kwRow?.keyword ?? '').trim().toLowerCase() === keyword.toLowerCase();
        }
        if (matches) {
          clientId = existingClientRaw.id;
          console.log('    ↻ already scanned with this keyword — reusing');
        } else {
          console.log('    ⚠ orphaned/stale client — deleting and scanning fresh');
          await supabase.from('clients').delete().eq('id', existingClientRaw.id);
        }
      }

      if (!clientId) {
        const { data: client, error: clientErr } = await supabase
          .from('clients').insert({
            business_name: loc.matchedName ?? loc.brand, address: loc.matchedAddress, latitude: loc.lat,
            longitude: loc.lng, service_radius_miles: 1.6, status: 'paused', billing_mode: 'agency_managed',
            is_outreach_lead: true, pending_buyer_email: email, industry: normalizeIndustry(null, { businessName: loc.matchedName ?? loc.brand, keyword }),
          }).select('*').single<ClientRow>();
        if (clientErr || !client) {
          console.log(`    ✗ client insert failed: ${clientErr?.message}`);
          appendLocationRow({ platform, brand: loc.brand, matched_name: loc.matchedName ?? '', matched_address: loc.matchedAddress ?? '', category_keyword: keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `client insert: ${clientErr?.message ?? 'no row'}` });
          appendProgress(loc.placeId);
          stats.nFailed++;
          continue;
        }
        clientId = client.id;

        const { data: location, error: locErr } = await supabase
          .from('client_locations').insert({
            client_id: client.id, is_primary: true, label: loc.matchedName ?? loc.brand, address: loc.matchedAddress,
            latitude: loc.lat, longitude: loc.lng, service_radius_miles: 1.6, google_place_id: loc.placeId, google_place_match_status: 'auto',
          }).select('*').single<ClientLocationRow>();
        if (locErr || !location) {
          await supabase.from('clients').delete().eq('id', client.id);
          console.log(`    ✗ location insert failed: ${locErr?.message}`);
          appendLocationRow({ platform, brand: loc.brand, matched_name: loc.matchedName ?? '', matched_address: loc.matchedAddress ?? '', category_keyword: keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `location insert: ${locErr?.message ?? 'no row'}` });
          appendProgress(loc.placeId);
          stats.nFailed++;
          continue;
        }

        const { data: kw, error: kwErr } = await supabase
          .from('tracked_keywords').insert({ client_id: client.id, location_id: location.id, keyword, is_primary: true }).select('*').single<TrackedKeywordRow>();
        if (kwErr || !kw) {
          await supabase.from('clients').delete().eq('id', client.id);
          console.log(`    ✗ keyword insert failed: ${kwErr?.message}`);
          appendLocationRow({ platform, brand: loc.brand, matched_name: loc.matchedName ?? '', matched_address: loc.matchedAddress ?? '', category_keyword: keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `keyword insert: ${kwErr?.message ?? 'no row'}` });
          appendProgress(loc.placeId);
          stats.nFailed++;
          continue;
        }

        const scanResult = await runScanForLocation(supabase, {
          client: { id: client.id, business_name: loc.matchedName ?? loc.brand }, location,
          keyword: { id: kw.id, keyword }, scanType: 'on_demand', triggeredBy: null,
        });
        if ('scanId' in scanResult && scanResult.scanId) {
          const { data: scanRow } = await supabase.from('scans').select('dfs_cost_cents').eq('id', scanResult.scanId).maybeSingle<{ dfs_cost_cents: number | null }>();
          dfsCostThisRow = (scanRow?.dfs_cost_cents ?? 0) / 100;
        }
        cumulative += dfsCostThisRow;
        if (!scanResult.ok) {
          await supabase.from('clients').delete().eq('id', client.id);
          console.log(`    ✗ scan failed: ${scanResult.error}`);
          appendLocationRow({ platform, brand: loc.brand, matched_name: loc.matchedName ?? '', matched_address: loc.matchedAddress ?? '', category_keyword: keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: dfsCostThisRow, status: 'failed', failure_reason: `scan: ${scanResult.error}` });
          appendProgress(loc.placeId);
          stats.nFailed++;
          writeRollup(new Map([...platformStats].map(([p, s]) => [p, s])));
          continue;
        }
      }

      const { data: scanRow2 } = await supabase
        .from('scans').select('id, turf_score').eq('client_id', clientId).eq('status', 'complete')
        .order('created_at', { ascending: false }).limit(1).maybeSingle<{ id: string; turf_score: number | null }>();
      let rankAtPin: number | string = '';
      let shareUrl = '';
      const turfScoreVal: number | string = scanRow2?.turf_score ?? '';
      if (scanRow2) {
        const { data: pinPt } = await supabase.from('scan_points').select('rank').eq('scan_id', scanRow2.id).eq('grid_x', 4).eq('grid_y', 4).maybeSingle<{ rank: number | null }>();
        rankAtPin = pinPt?.rank ?? '';
        const { data: existingLink } = await supabase.from('scan_share_links').select('id').eq('scan_id', scanRow2.id).order('created_at', { ascending: false }).limit(1).maybeSingle<{ id: string }>();
        if (existingLink) shareUrl = `${APP_ORIGIN}/share/${existingLink.id}`;
        else {
          const expiresAt = new Date(Date.now() + DEFAULT_SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString();
          const { data: link } = await supabase.from('scan_share_links').insert({ scan_id: scanRow2.id, expires_at: expiresAt, cta_text: SHARE_CTA_TEXT, cta_url: SHARE_CTA_URL }).select('id').single<{ id: string }>();
          if (link) shareUrl = `${APP_ORIGIN}/share/${link.id}`;
        }
      }

      const absent = rankAtPin === '';
      const inTop3 = !absent && Number(rankAtPin) >= 1 && Number(rankAtPin) <= 3;
      const weak = !inTop3; // "NOT in top 3 at its own pin" — same C3 definition, absent counts as weak.

      console.log(`    ✓ TurfScore ${turfScoreVal} · pin=${rankAtPin || 'absent'} · weak=${weak} · cost=$${dfsCostThisRow.toFixed(3)} · cumulative=$${cumulative.toFixed(3)}`);

      appendLocationRow({
        platform, brand: loc.brand, matched_name: loc.matchedName ?? '', matched_address: loc.matchedAddress ?? '',
        category_keyword: keyword, turfscore: turfScoreVal, rank_at_pin: rankAtPin, in_top3: inTop3, absent,
        share_link: shareUrl, dfs_cost_usd: dfsCostThisRow, status: 'scanned', failure_reason: '',
      });
      appendProgress(loc.placeId);

      stats.nScanned++;
      if (weak) stats.nWeak++;
      if (absent) stats.nAbsent++;
      if (shareUrl) stats.shareLinks.push(shareUrl);
      const rankSort = absent ? 999 : Number(rankAtPin);
      if (rankSort > stats.worstRank) {
        stats.worstRank = rankSort;
        stats.worstCity = extractCity(loc.matchedAddress);
      }

      writeRollup(new Map([...platformStats].map(([p, s]) => [p, s])));
    }
  }

  console.log(`\n[c2-portfolio] DONE. cumulative=$${cumulative.toFixed(3)} / cap $${cap.toFixed(2)}`);
  if (stopReason) console.log(`[c2-portfolio] STOPPED EARLY: ${stopReason}`);
  console.log('[c2-portfolio] per-platform summary:');
  for (const [p, s] of platformStats) {
    console.log(`  ${p}: brands=${s.nBrandsFound} scanned=${s.nScanned} failed=${s.nFailed} weak=${s.nWeak} absent=${s.nAbsent} worst_city=${s.worstCity}`);
  }
}

main().catch((e) => {
  console.error('[c2-portfolio] fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
