/**
 * outreach-c1-rescan.ts — corrected-keyword rescan pass (64 companies,
 * Anthony-approved, 2026-08-27).
 *
 * Prior batch (outreach-c1-scan.ts) auto-derived the scan keyword from
 * Google Places primaryType, which produced wrong keywords for a chunk of
 * companies ("general contractor" for HVAC cos, "street address" garbage).
 * This pass uses 01-lists/c1/c1-rescan-queue.csv's scan_keyword column
 * VERBATIM — no derivation.
 *
 * 16 of the 64 companies already have a rollup row from the prior batch
 * (wrong keyword) — rescanning them is EXPECTED and their rollup row is
 * overwritten in place (upsertRollup is keyed by company, same as before).
 * The other 48 are new to the rollup.
 *
 * Resume bookkeeping for THIS pass lives in a separate progress file
 * (_rescan-progress.csv) — distinct from the main rollup, because a
 * company's PRE-EXISTING rollup row (old keyword) must never be mistaken
 * for "already done" here.
 *
 * Orphan-guard, kept: before creating a fresh client, if one already
 * exists for this company's synthetic email, check for a COMPLETE scan
 * whose keyword matches scan_keyword (case-insensitive). If found, reuse
 * (no respend — handles a resumed prior run of this same script). If not
 * found (old-keyword scan from the original batch, OR an orphan from a
 * killed run of this script), delete and do a fresh insert + scan.
 *
 * Run: npx tsx scripts/outreach-c1-rescan.ts [--cap 9.94] [--limit N] [--dry-run]
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { searchPlaces, getPlaceDetails } from '../lib/google/places';
import { runScanForLocation } from '../lib/scans/runScan';
import type { ClientRow, ClientLocationRow, TrackedKeywordRow } from '../lib/supabase/types';

const OUTREACH_ROOT = path.resolve(process.cwd(), '../fourdots-outreach');
const INPUT_CSV = path.join(OUTREACH_ROOT, '01-lists/c1/c1-scan-queue-2.csv');
const RESULTS_DIR = path.join(OUTREACH_ROOT, '02-turfscan/c1-scan-results');
const ROLLUP_PATH = path.join(RESULTS_DIR, 'c1-scan-rollup.csv');
const PROGRESS_PATH = path.join(RESULTS_DIR, '_scan-queue-2-progress.csv');
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

const DEFAULT_SHARE_DAYS = 90;
const SHARE_CTA_TEXT = 'See your full territory map';
const SHARE_CTA_URL = 'https://localleadmachine.io/';

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

// ─── Input row type ────────────────────────────────────────────────────
type InputRow = {
  company: string; domain: string; geo: string; city: string; state: string;
  country: string; scan_keyword: string; trade: string; arm: string;
};

function readInput(): InputRow[] {
  const raw = fs.readFileSync(INPUT_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const rows: InputRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    rows.push({
      company: c[idx('company')] ?? '',
      domain: c[idx('domain')] ?? '',
      geo: c[idx('geo')] ?? '',
      city: c[idx('city')] ?? '',
      state: c[idx('state')] ?? '',
      country: c[idx('country')] ?? '',
      scan_keyword: (c[idx('scan_keyword')] ?? '').trim(),
      trade: c[idx('trade')] ?? '',
      arm: c[idx('arm')] ?? '',
    });
  }
  return rows;
}

// ─── Metro / distance_phrase (same convention as outreach-c1-scan.ts) ──
const GTA = new Set(['toronto', 'mississauga', 'brampton', 'markham', 'vaughan', 'oakville', 'burlington', 'richmond hill', 'ajax', 'pickering', 'whitby', 'oshawa', 'milton', 'newmarket', 'aurora', 'caledon', 'halton hills', 'king city', 'innisfil', 'orangeville', 'lincoln', 'niagara-on-the-lake']);
const CALGARY_METRO = new Set(['calgary', 'airdrie', 'cochrane', 'chestermere', 'okotoks']);
const EDMONTON_METRO = new Set(['edmonton', 'sherwood park', 'st. albert', 'spruce grove', 'leduc']);
const METRO_VAN = new Set(['vancouver', 'burnaby', 'surrey', 'delta', 'richmond', 'coquitlam', 'port coquitlam', 'new westminster', 'north vancouver', 'maple ridge', 'pitt meadows', 'langley']);
const VICTORIA_METRO = new Set(['victoria', 'saanich', 'esquimalt']);
const US_METRO_LABEL: Record<string, string> = { dfw: 'Dallas-Fort Worth', atlanta: 'Atlanta', houston: 'Houston' };

function deriveMetro(row: InputRow): string {
  if (US_METRO_LABEL[row.geo]) return US_METRO_LABEL[row.geo];
  const city = (row.city || row.geo).trim();
  const key = city.toLowerCase();
  if (GTA.has(key)) return 'Greater Toronto Area';
  if (CALGARY_METRO.has(key)) return 'Calgary';
  if (EDMONTON_METRO.has(key)) return 'Edmonton';
  if (METRO_VAN.has(key)) return 'Metro Vancouver';
  if (VICTORIA_METRO.has(key)) return 'Victoria';
  return city;
}
function distancePhrase(country: string): string {
  return country.trim().toLowerCase() === 'canada' ? 'four kilometres' : 'three miles';
}

// ─── Rollup persistence (overwrite-by-company, same shape as the main pipeline) ──
const ROLLUP_HEADER = [
  'company', 'domain', 'geo', 'metro', 'city', 'state', 'country',
  'street', 'full_address', 'matched_address', 'category_keyword',
  'turfscore', 'rank_at_pin', 'rank_at_edge', 'edge_point',
  'distance_phrase', 'share_link', 'status', 'failure_reason', 'dfs_cost_usd',
].join(',');

function loadRollup(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(ROLLUP_PATH)) return map;
  const lines = fs.readFileSync(ROLLUP_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = 1; i < lines.length; i++) {
    const company = parseCsvLine(lines[i])[0];
    if (company) map.set(company, lines[i]);
  }
  return map;
}
function writeRollup(map: Map<string, string>) {
  fs.writeFileSync(ROLLUP_PATH, [ROLLUP_HEADER, ...map.values()].join('\n') + '\n');
}
function upsertRollup(
  map: Map<string, string>,
  row: {
    company: string; domain: string; geo: string; metro: string; city: string; state: string;
    country: string; matched_address: string; category_keyword: string;
    turfscore: number | string; rank_at_pin: number | string; rank_at_edge: number | string;
    edge_point: string; distance_phrase: string; share_link: string; status: string;
    failure_reason: string; dfs_cost_usd: number;
  }
) {
  const line = [
    csvField(row.company), csvField(row.domain), csvField(row.geo), csvField(row.metro),
    csvField(row.city), csvField(row.state), csvField(row.country), csvField(''), csvField(''),
    csvField(row.matched_address), csvField(row.category_keyword),
    row.turfscore, row.rank_at_pin, row.rank_at_edge, csvField(row.edge_point),
    csvField(row.distance_phrase), csvField(row.share_link), csvField(row.status),
    csvField(row.failure_reason), row.dfs_cost_usd.toFixed(3),
  ].join(',');
  map.set(row.company, line);
  writeRollup(map); // write after every row — never lose completed scans
}

// ─── Rescan-pass progress (separate from the main rollup, resume-safe) ─
function loadProgress(): Map<string, { status: string; cost: number }> {
  const map = new Map<string, { status: string; cost: number }>();
  if (!fs.existsSync(PROGRESS_PATH)) return map;
  const lines = fs.readFileSync(PROGRESS_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c[0]) map.set(c[0], { status: c[1] ?? '', cost: Number(c[2]) || 0 });
  }
  return map;
}
function writeProgress(map: Map<string, { status: string; cost: number }>) {
  const lines = ['company,status,dfs_cost_usd'];
  for (const [company, v] of map) {
    lines.push([csvField(company), csvField(v.status), v.cost.toFixed(3)].join(','));
  }
  fs.writeFileSync(PROGRESS_PATH, lines.join('\n') + '\n');
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

// ─── Places resolution (name+city/state/country, then address-only fallback) ──
async function resolvePlace(row: InputRow): Promise<{
  lat: number | null; lng: number | null; matchedAddress: string | null;
  primaryType: string | null;
}> {
  const regionCode = row.country.trim().toLowerCase() === 'canada' ? 'CA' : 'US';
  const locatorString = [row.city, row.state, row.country].filter(Boolean).join(', ');
  const attempt1Query = `${row.company}, ${locatorString}`.trim();
  let search = await searchPlaces({ query: attempt1Query, latitude: null, longitude: null, maxResults: 3, regionCode });
  if (search.candidates.length === 0 && locatorString) {
    search = await searchPlaces({ query: locatorString, latitude: null, longitude: null, maxResults: 3, regionCode });
  }
  const candidate = search.candidates[0];
  if (!candidate) return { lat: null, lng: null, matchedAddress: null, primaryType: null };

  const details = await getPlaceDetails(candidate.placeId);
  if (!details || details.latitude === null || details.longitude === null) {
    return { lat: null, lng: null, matchedAddress: details?.formattedAddress ?? null, primaryType: details?.primaryType ?? null };
  }
  return { lat: details.latitude, lng: details.longitude, matchedAddress: details.formattedAddress, primaryType: details.primaryType };
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const capIdx = args.indexOf('--cap');
  const limitIdx = args.indexOf('--limit');
  const dryRun = args.includes('--dry-run');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  let cap: number;
  if (capIdx !== -1) {
    cap = Number(args[capIdx + 1]);
  } else {
    const balance = await fetchDfsBalance();
    cap = balance !== null ? Math.max(0, balance - 1) : 5;
    console.log(`[c1-queue2] live DFS balance = ${balance !== null ? '$' + balance.toFixed(2) : 'unknown'} -> effective cap = $${cap.toFixed(2)}`);
  }

  const inputRows = readInput();
  const work = limit ? inputRows.slice(0, limit) : inputRows;
  const rollup = loadRollup();
  const progress = loadProgress();

  const supabase = getServerSupabase();
  const COST_PER_SCAN_ESTIMATE = 0.162;
  let cumulative = 0;
  for (const v of progress.values()) cumulative += v.cost;
  console.log(`[c1-queue2] queue=${work.length} resuming with cumulative=$${cumulative.toFixed(3)} from ${progress.size} prior progress rows`);

  let scanned = 0, failed = 0, skippedAlready = 0;
  let stopReason = '';
  let rankedAtPin = 0, absentAtPin = 0;

  for (let i = 0; i < work.length; i++) {
    const row = work[i];
    const prior = progress.get(row.company);
    if (prior && (prior.status === 'rescanned' || prior.status === 'failed')) {
      skippedAlready++;
      continue;
    }
    // "Skip anything already scanned" — this queue is supposed to be
    // 100 companies with no prior rollup row, but guard against any
    // overlap anyway rather than trusting that claim blindly.
    const existingRollupLine = rollup.get(row.company);
    if (existingRollupLine) {
      const cols = parseCsvLine(existingRollupLine);
      if (cols[17] === 'scanned') {
        console.log(`\n[${i + 1}/${work.length}] ${row.company} — already has a scanned rollup row, skipping (no spend)`);
        progress.set(row.company, { status: 'rescanned', cost: 0 });
        writeProgress(progress);
        skippedAlready++;
        continue;
      }
    }

    if (cumulative + COST_PER_SCAN_ESTIMATE > cap) {
      stopReason = `budget cap reached ($${cap.toFixed(2)}) before ${row.company} (cumulative=$${cumulative.toFixed(3)})`;
      break;
    }

    console.log(`\n[${i + 1}/${work.length}] ${row.company} (${row.city}, ${row.state}) — keyword "${row.scan_keyword}"`);

    if (dryRun) {
      console.log(`  (dry-run) would rescan — cumulative would become $${(cumulative + COST_PER_SCAN_ESTIMATE).toFixed(3)}`);
      cumulative += COST_PER_SCAN_ESTIMATE;
      continue;
    }

    const keyword = row.scan_keyword.toLowerCase();
    if (!keyword) {
      console.log('  ✗ empty scan_keyword — skipping');
      progress.set(row.company, { status: 'failed', cost: 0 });
      writeProgress(progress);
      failed++;
      continue;
    }

    const place = await resolvePlace(row);
    if (place.lat === null || place.lng === null) {
      console.log('  ✗ geocode miss — no usable Places match');
      upsertRollup(rollup, {
        company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
        city: row.city, state: row.state, country: row.country, matched_address: '',
        category_keyword: row.scan_keyword, turfscore: '', rank_at_pin: '', rank_at_edge: '',
        edge_point: '', distance_phrase: distancePhrase(row.country), share_link: '',
        status: 'failed', failure_reason: 'geocode miss (no Places match on name+city/state/country or city/state/country alone)',
        dfs_cost_usd: 0,
      });
      progress.set(row.company, { status: 'failed', cost: 0 });
      writeProgress(progress);
      failed++;
      continue;
    }

    const email = `outreach-c1+${slugify(row.company)}@fourdots-outreach.local`;

    // Orphan-guard / correct-keyword check: reuse ONLY if a complete scan
    // already exists for THIS keyword (resumed prior run of this script).
    // Otherwise delete whatever's there (old-keyword scan from the
    // original batch, or an orphan from a killed run of this script) and
    // scan fresh.
    const { data: existingClientRaw } = await supabase
      .from('clients')
      .select('id')
      .eq('is_outreach_lead', true)
      .eq('pending_buyer_email', email)
      .maybeSingle<{ id: string }>();

    let clientId: string | null = null;
    let dfsCostThisRow = 0;
    let reused = false;

    if (existingClientRaw) {
      const { data: scanWithKw } = await supabase
        .from('scans')
        .select('id, keyword_id, tracked_keywords!inner(keyword)')
        .eq('client_id', existingClientRaw.id)
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; keyword_id: string }>();
      // Simpler/robust check: pull the keyword text directly.
      let matches = false;
      if (scanWithKw) {
        const { data: kwRow } = await supabase.from('tracked_keywords').select('keyword').eq('id', scanWithKw.keyword_id).maybeSingle<{ keyword: string }>();
        matches = (kwRow?.keyword ?? '').trim().toLowerCase() === keyword;
      }
      if (matches) {
        clientId = existingClientRaw.id;
        reused = true;
        console.log('  ↻ already rescanned with this exact keyword in a prior run of THIS script — reusing');
      } else {
        console.log('  ⚠ existing client has stale/no matching-keyword scan — deleting and rescanning fresh');
        await supabase.from('clients').delete().eq('id', existingClientRaw.id);
      }
    }

    if (!clientId) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .insert({
          business_name: row.company, address: place.matchedAddress, latitude: place.lat,
          longitude: place.lng, service_radius_miles: 1.6, status: 'paused',
          billing_mode: 'agency_managed', is_outreach_lead: true, pending_buyer_email: email,
          industry: place.primaryType || row.trade,
        })
        .select('*')
        .single<ClientRow>();
      if (clientErr || !client) {
        console.log(`  ✗ client insert failed: ${clientErr?.message}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
          city: row.city, state: row.state, country: row.country, matched_address: place.matchedAddress ?? '',
          category_keyword: row.scan_keyword, turfscore: '', rank_at_pin: '', rank_at_edge: '',
          edge_point: '', distance_phrase: distancePhrase(row.country), share_link: '',
          status: 'failed', failure_reason: `client insert: ${clientErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
        progress.set(row.company, { status: 'failed', cost: 0 });
        writeProgress(progress);
        failed++;
        continue;
      }
      clientId = client.id;

      const { data: location, error: locErr } = await supabase
        .from('client_locations')
        .insert({
          client_id: client.id, is_primary: true, label: row.company, address: place.matchedAddress,
          latitude: place.lat, longitude: place.lng, service_radius_miles: 1.6,
          google_place_match_status: 'manual',
        })
        .select('*')
        .single<ClientLocationRow>();
      if (locErr || !location) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ location insert failed: ${locErr?.message}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
          city: row.city, state: row.state, country: row.country, matched_address: place.matchedAddress ?? '',
          category_keyword: row.scan_keyword, turfscore: '', rank_at_pin: '', rank_at_edge: '',
          edge_point: '', distance_phrase: distancePhrase(row.country), share_link: '',
          status: 'failed', failure_reason: `location insert: ${locErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
        progress.set(row.company, { status: 'failed', cost: 0 });
        writeProgress(progress);
        failed++;
        continue;
      }

      const { data: kw, error: kwErr } = await supabase
        .from('tracked_keywords')
        .insert({ client_id: client.id, location_id: location.id, keyword, is_primary: true })
        .select('*')
        .single<TrackedKeywordRow>();
      if (kwErr || !kw) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ keyword insert failed: ${kwErr?.message}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
          city: row.city, state: row.state, country: row.country, matched_address: place.matchedAddress ?? '',
          category_keyword: row.scan_keyword, turfscore: '', rank_at_pin: '', rank_at_edge: '',
          edge_point: '', distance_phrase: distancePhrase(row.country), share_link: '',
          status: 'failed', failure_reason: `keyword insert: ${kwErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
        progress.set(row.company, { status: 'failed', cost: 0 });
        writeProgress(progress);
        failed++;
        continue;
      }

      const scanResult = await runScanForLocation(supabase, {
        client: { id: client.id, business_name: row.company },
        location,
        keyword: { id: kw.id, keyword },
        scanType: 'on_demand',
        triggeredBy: null,
      });

      if ('scanId' in scanResult && scanResult.scanId) {
        const { data: scanRow } = await supabase.from('scans').select('dfs_cost_cents').eq('id', scanResult.scanId).maybeSingle<{ dfs_cost_cents: number | null }>();
        dfsCostThisRow = (scanRow?.dfs_cost_cents ?? 0) / 100;
      }
      cumulative += dfsCostThisRow;

      if (!scanResult.ok) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ scan failed: ${scanResult.error}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
          city: row.city, state: row.state, country: row.country, matched_address: place.matchedAddress ?? '',
          category_keyword: row.scan_keyword, turfscore: '', rank_at_pin: '', rank_at_edge: '',
          edge_point: '', distance_phrase: distancePhrase(row.country), share_link: '',
          status: 'failed', failure_reason: `scan: ${scanResult.error}`, dfs_cost_usd: dfsCostThisRow,
        });
        progress.set(row.company, { status: 'failed', cost: dfsCostThisRow });
        writeProgress(progress);
        failed++;
        continue;
      }
    }

    // Pull rank_at_pin (4,4) and rank_at_edge (4,0) from the latest complete scan.
    const { data: scanRow2 } = await supabase
      .from('scans')
      .select('id, turf_score')
      .eq('client_id', clientId)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; turf_score: number | null }>();

    let rankAtPin: number | string = '';
    let rankAtEdge: number | string = '';
    let shareUrl = '';
    const turfScoreVal: number | string = scanRow2?.turf_score ?? '';

    if (scanRow2) {
      const { data: pinPt } = await supabase.from('scan_points').select('rank').eq('scan_id', scanRow2.id).eq('grid_x', 4).eq('grid_y', 4).maybeSingle<{ rank: number | null }>();
      const { data: edgePt } = await supabase.from('scan_points').select('rank').eq('scan_id', scanRow2.id).eq('grid_x', 4).eq('grid_y', 0).maybeSingle<{ rank: number | null }>();
      rankAtPin = pinPt?.rank ?? '';
      rankAtEdge = edgePt?.rank ?? '';
      if (rankAtPin !== '') rankedAtPin++; else absentAtPin++;

      const { data: existingLink } = await supabase.from('scan_share_links').select('id').eq('scan_id', scanRow2.id).order('created_at', { ascending: false }).limit(1).maybeSingle<{ id: string }>();
      if (existingLink) {
        shareUrl = `${APP_ORIGIN}/share/${existingLink.id}`;
      } else {
        const expiresAt = new Date(Date.now() + DEFAULT_SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { data: link } = await supabase.from('scan_share_links').insert({ scan_id: scanRow2.id, expires_at: expiresAt, cta_text: SHARE_CTA_TEXT, cta_url: SHARE_CTA_URL }).select('id').single<{ id: string }>();
        if (link) shareUrl = `${APP_ORIGIN}/share/${link.id}`;
      }
    }

    console.log(`  ✓ TurfScore ${turfScoreVal} · pin=${rankAtPin || 'unranked'} · edge=${rankAtEdge || 'unranked'} · keyword "${row.scan_keyword}" · cost=$${dfsCostThisRow.toFixed(3)} (reused=${reused}) · cumulative=$${cumulative.toFixed(3)}`);

    upsertRollup(rollup, {
      company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row),
      city: row.city, state: row.state, country: row.country, matched_address: place.matchedAddress ?? '',
      category_keyword: row.scan_keyword, turfscore: turfScoreVal, rank_at_pin: rankAtPin, rank_at_edge: rankAtEdge,
      edge_point: 'grid_x=4,grid_y=0 (north, ~1.6mi/2.57km from pin — actual TurfMap grid edge)',
      distance_phrase: distancePhrase(row.country), share_link: shareUrl, status: 'scanned',
      failure_reason: '', dfs_cost_usd: dfsCostThisRow,
    });
    progress.set(row.company, { status: 'rescanned', cost: dfsCostThisRow });
    writeProgress(progress);
    scanned++;
  }

  console.log(`\n[c1-queue2] DONE. scanned=${scanned} failed=${failed} skipped(already-done-this-pass)=${skippedAlready} remaining=${work.length - scanned - failed - skippedAlready} cumulative=$${cumulative.toFixed(3)} / cap $${cap.toFixed(2)}`);
  console.log(`[c1-queue2] ranked-at-pin=${rankedAtPin} absent-at-pin=${absentAtPin} (this run only; see rollup for full history)`);
  if (stopReason) console.log(`[c1-queue2] STOPPED EARLY: ${stopReason}`);
}

main().catch((e) => {
  console.error('[c1-queue2] fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
