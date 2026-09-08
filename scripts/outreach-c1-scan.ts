/**
 * outreach-c1-scan.ts — C1 home-services TurfScan batch (287 companies,
 * one scan per company, single-location operators — no sampling).
 *
 * For each row in fourdots-outreach/01-lists/c1/c1-eligible-scan-input.csv:
 *   1. Google Places Text Search on "{company}, {full_address}" (falls back
 *      to address-only if that yields nothing) to resolve lat/lng + a
 *      Google-classified primaryType for the category keyword. ONE retry
 *      max (name+address, then address-only) per the runbook's "do not
 *      retry more than once" rule.
 *   2. Derive ONE category keyword: Places primaryType/types first
 *      (humanized + " near me"), else a keyword/industry taxonomy match,
 *      else a generic "{industry} near me" last resort.
 *   3. Insert clients/client_locations/tracked_keywords rows and call the
 *      SAME runScanForLocation() the production trigger/cron use — 9x9/81
 *      point grid, 1.6mi (2.57km) half-width, desktop (TurfMap's real
 *      defaults; NOT the SOP's 49pt/1mi/mobile — see TURFMAP-RUNBOOK.md §2).
 *   4. Pull rank_at_pin (grid_x=4,grid_y=4 — center) and rank_at_edge
 *      (grid_x=4,grid_y=0 — north edge, ~1.6mi/2.57km from the pin, the
 *      actual edge of TurfMap's grid) from scan_points.
 *   5. Create a scan_share_link.
 *   6. Upsert one row into 02-turfscan/c1-scan-results/c1-scan-rollup.csv.
 *
 * Budget: hard cap via --cap (default: min($55, live DFS balance - $1
 * buffer)). Stops cleanly (saves resume state) rather than overspending.
 *
 * Resume: rows already present in the rollup CSV with status=scanned or
 * status=failed are skipped (failed rows are NOT retried across runs,
 * per "do not retry more than once").
 *
 * Run: npx tsx scripts/outreach-c1-scan.ts [--cap 26] [--limit N] [--dry-run]
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
const INPUT_CSV = path.join(OUTREACH_ROOT, '01-lists/c1/c1-eligible-scan-input.csv');
const DROPPED_DOMAINS_TXT = path.join(OUTREACH_ROOT, '01-lists/c1/c1-dropped-domains.txt');
const FINAL_LIST_CSV = path.join(OUTREACH_ROOT, '01-lists/c1/c1-final-list.csv');
const RESULTS_DIR = path.join(OUTREACH_ROOT, '02-turfscan/c1-scan-results');
const ROLLUP_PATH = path.join(RESULTS_DIR, 'c1-scan-rollup.csv');
const STATE_PATH = path.join(RESULTS_DIR, '_batch-state.json');
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
  company: string; domain: string; geo: string; industry: string; city: string;
  state: string; country: string; keywords: string; street: string; full_address: string;
  reviews: string; capacity_signal: string;
  /** Set for rows appended from c1-final-list.csv (2026-08-26 coordinator
   *  correction) — always sorts after everything else, regardless of geo
   *  or Tier1 status. */
  forceTier?: number;
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
      industry: c[idx('industry')] ?? '',
      city: c[idx('city')] ?? '',
      state: c[idx('state')] ?? '',
      country: c[idx('country')] ?? '',
      keywords: c[idx('keywords')] ?? '',
      street: c[idx('street')] ?? '',
      full_address: c[idx('full_address')] ?? '',
      reviews: c[idx('reviews')] ?? '',
      capacity_signal: c[idx('capacity_signal')] ?? '',
    });
  }
  return rows;
}

/** 2026-08-26 ICP-audit correction: 63 domains confirmed off-ICP. Must not
 *  consume scan budget going forward — rows already scanned before this
 *  correction landed are left as-is (sunk cost, not retroactively undone),
 *  but not-yet-scanned rows on this list are excluded entirely. */
function readDroppedDomains(): Set<string> {
  if (!fs.existsSync(DROPPED_DOMAINS_TXT)) return new Set();
  return new Set(
    fs.readFileSync(DROPPED_DOMAINS_TXT, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** 2026-08-26 coordinator correction: 16 companies added in c1-final-list.csv
 *  with ad_spend_signal starting 'adlib_active' that are NOT already in the
 *  287-row eligible input. Appended at the end of the queue (forced tier 3)
 *  if budget remains. These rows pre-date the enrichment pass, so
 *  full_address/street are usually empty — resolvePlace() falls back to
 *  city/state/country for the Places query in that case. */
function readAppendCompanies(existingDomains: Set<string>): InputRow[] {
  if (!fs.existsSync(FINAL_LIST_CSV)) return [];
  const raw = fs.readFileSync(FINAL_LIST_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const out: InputRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const domain = (c[idx('domain')] ?? '').trim();
    const adSpendSignal = c[idx('ad_spend_signal')] ?? '';
    if (!adSpendSignal.startsWith('adlib_active')) continue;
    if (existingDomains.has(domain.toLowerCase())) continue; // already in the 287-row input
    out.push({
      company: c[idx('company')] ?? '',
      domain,
      geo: c[idx('geo')] ?? '',
      industry: c[idx('industry')] ?? '',
      city: c[idx('city')] ?? '',
      state: c[idx('state')] ?? '',
      country: c[idx('country')] ?? '',
      keywords: c[idx('keywords')] ?? '',
      street: c[idx('street')] ?? '',
      full_address: c[idx('full_address')] ?? '',
      reviews: c[idx('reviews')] ?? '',
      capacity_signal: c[idx('capacity_signal')] ?? '',
      forceTier: 3,
    });
  }
  return out;
}

// ─── Priority ordering (2026-08-26 coordinator correction) ────────────
// Input CSV is geo-alphabetical, which buries Ontario (69 rows, Anthony's
// home market) at the end. With budget only covering a fraction of 287
// rows, unordered processing would starve Ontario. Priority tiers:
//   0. Ontario (any row, regardless of tier)
//   1. Tier 1 elsewhere — reviews >= 40 AND capacity_signal non-empty
//   2. everything else
// Stable sort (Array.prototype.sort is stable in V8) preserves each
// tier's original relative CSV order. Applied to the full input list on
// every run, so it's safe across restarts — already-scanned/failed rows
// (tracked in the rollup) are still skipped wherever they land in the
// new order; this only changes which NOT-yet-done rows come next.
function priorityOf(row: InputRow): number {
  if (row.forceTier !== undefined) return row.forceTier;
  if (row.geo.trim().toLowerCase() === 'ontario') return 0;
  const reviewCount = Number(row.reviews);
  const isTier1 = Number.isFinite(reviewCount) && reviewCount >= 40 && row.capacity_signal.trim() !== '';
  if (isTier1) return 1;
  return 2;
}

function prioritySort(rows: InputRow[]): InputRow[] {
  return [...rows]
    .map((row, originalIndex) => ({ row, originalIndex, tier: priorityOf(row) }))
    .sort((a, b) => a.tier - b.tier || a.originalIndex - b.originalIndex)
    .map((x) => x.row);
}

// ─── Category keyword derivation ──────────────────────────────────────
const PLACES_NOISE_TYPES = new Set([
  'establishment', 'point_of_interest', 'store', 'local_government_office',
  'premise', 'subpremise', 'route',
]);

const TAXONOMY: Array<[RegExp, string]> = [
  [/roofing|\broof\b/, 'roofing contractor'],
  [/plumb/, 'plumber'],
  [/electric/, 'electrician'],
  [/hvac|heating.*cooling|furnace|air condition/, 'hvac contractor'],
  [/landscap/, 'landscaper'],
  [/\bpaint/, 'painter'],
  [/flooring|hardwood floor|\bcarpet\b/, 'flooring contractor'],
  [/window.*door|door.*window|\bwindows\b/, 'window and door installer'],
  [/siding/, 'siding contractor'],
  [/insulation/, 'insulation contractor'],
  [/\bfence\b|fencing/, 'fence contractor'],
  [/garage door/, 'garage door repair service'],
  [/pest control|exterminat/, 'pest control service'],
  [/moving|\bmovers\b/, 'moving company'],
  [/cleaning service|house clean|janitorial/, 'cleaning service'],
  [/tree service|tree removal|arboris/, 'tree service'],
  [/foundation repair/, 'foundation repair contractor'],
  [/waterproofing/, 'waterproofing contractor'],
  [/remodel|renovation/, 'general contractor'],
  [/pool (service|clean|maint)/, 'pool cleaning service'],
  [/solar/, 'solar energy contractor'],
  [/\bglass\b|mirror/, 'glass repair service'],
  [/\bdeck\b|patio/, 'deck builder'],
  [/driveway|paving|asphalt/, 'paving contractor'],
  [/appliance repair/, 'appliance repair service'],
  [/locksmith/, 'locksmith'],
  [/gutter/, 'gutter service'],
  [/mason/, 'masonry contractor'],
  [/drywall/, 'drywall contractor'],
  [/restoration|water damage|fire damage|\bmold\b/, 'restoration company'],
  [/demolition/, 'demolition contractor'],
  [/excavat/, 'excavation contractor'],
  [/septic/, 'septic tank service'],
  [/well drilling/, 'well drilling contractor'],
  [/chimney/, 'chimney sweep'],
  [/home inspect/, 'home inspector'],
  [/security system|\balarm\b/, 'security system supplier'],
  [/concrete/, 'concrete contractor'],
  [/pressure wash|power wash/, 'pressure washing service'],
  [/handyman/, 'handyman'],
  [/general contractor|\bconstruction\b/, 'general contractor'],
];

function humanizeType(t: string): string {
  return t.replace(/_/g, ' ').toLowerCase().trim();
}

function keywordFromPlaces(primaryType: string | null, types: string[]): string | null {
  const primary = primaryType && !PLACES_NOISE_TYPES.has(primaryType) ? primaryType : null;
  const fromTypes = types.find((t) => !PLACES_NOISE_TYPES.has(t)) ?? null;
  const raw = primary ?? fromTypes;
  if (!raw) return null;
  return `${humanizeType(raw)} near me`;
}

function keywordFromTaxonomy(keywords: string, industry: string): string | null {
  const hay = `${keywords} ${industry}`.toLowerCase();
  for (const [re, label] of TAXONOMY) {
    if (re.test(hay)) return `${label} near me`;
  }
  return null;
}

// ─── Metro derivation ──────────────────────────────────────────────────
const GTA = new Set(['toronto', 'mississauga', 'brampton', 'markham', 'vaughan', 'oakville', 'burlington', 'richmond hill', 'ajax', 'pickering', 'whitby', 'oshawa', 'milton', 'newmarket', 'aurora', 'caledon', 'halton hills', 'king city', 'innisfil', 'orangeville', 'lincoln', 'niagara-on-the-lake']);
const CALGARY_METRO = new Set(['calgary', 'airdrie', 'cochrane', 'chestermere', 'okotoks']);
const EDMONTON_METRO = new Set(['edmonton', 'sherwood park', 'st. albert', 'spruce grove', 'leduc']);
const METRO_VAN = new Set(['vancouver', 'burnaby', 'surrey', 'delta', 'richmond', 'coquitlam', 'port coquitlam', 'new westminster', 'north vancouver', 'maple ridge', 'pitt meadows', 'langley']);
const VICTORIA_METRO = new Set(['victoria', 'saanich', 'esquimalt']);
const US_METRO_LABEL: Record<string, string> = { dfw: 'Dallas-Fort Worth', atlanta: 'Atlanta', houston: 'Houston' };

function deriveMetro(row: InputRow, matchedAddress: string | null): string {
  if (US_METRO_LABEL[row.geo]) return US_METRO_LABEL[row.geo];
  let city = row.city.trim();
  if (!city && matchedAddress) {
    const parts = matchedAddress.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) city = parts[parts.length - 3] ?? parts[0];
  }
  if (!city) city = row.geo;
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

// ─── Rollup persistence (upsert by company) ───────────────────────────
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
    country: string; street: string; full_address: string; matched_address: string;
    category_keyword: string; turfscore: number | string; rank_at_pin: number | string;
    rank_at_edge: number | string; edge_point: string; distance_phrase: string;
    share_link: string; status: string; failure_reason: string; dfs_cost_usd: number;
  }
) {
  const line = [
    csvField(row.company), csvField(row.domain), csvField(row.geo), csvField(row.metro),
    csvField(row.city), csvField(row.state), csvField(row.country), csvField(row.street),
    csvField(row.full_address), csvField(row.matched_address), csvField(row.category_keyword),
    row.turfscore, row.rank_at_pin, row.rank_at_edge, csvField(row.edge_point),
    csvField(row.distance_phrase), csvField(row.share_link), csvField(row.status),
    csvField(row.failure_reason), row.dfs_cost_usd.toFixed(3),
  ].join(',');
  map.set(row.company, line);
  writeRollup(map); // write after every row — never lose completed scans
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

// ─── Places resolution (name+address, then address-only fallback) ────
async function resolvePlace(row: InputRow): Promise<{
  lat: number | null; lng: number | null; matchedAddress: string | null;
  matchedName: string | null; primaryType: string | null; types: string[];
  addressSource: 'name+address' | 'address-only' | 'none';
}> {
  const regionCode = row.country.trim().toLowerCase() === 'canada' ? 'CA' : 'US';
  // Rows appended from c1-final-list.csv (2026-08-26) pre-date the
  // enrichment pass and usually have no full_address — fall back to a
  // city/state/country locator string so the query is still anchored.
  const addressForQuery = row.full_address.trim()
    || [row.city, row.state, row.country].filter(Boolean).join(', ');
  const attempt1Query = `${row.company}, ${addressForQuery}`.trim();
  let search = await searchPlaces({ query: attempt1Query, latitude: null, longitude: null, maxResults: 3, regionCode });
  let source: 'name+address' | 'address-only' | 'none' = 'name+address';
  if (search.candidates.length === 0 && addressForQuery) {
    search = await searchPlaces({ query: addressForQuery, latitude: null, longitude: null, maxResults: 3, regionCode });
    source = 'address-only';
  }
  const candidate = search.candidates[0];
  if (!candidate) return { lat: null, lng: null, matchedAddress: null, matchedName: null, primaryType: null, types: [], addressSource: 'none' };

  const details = await getPlaceDetails(candidate.placeId);
  if (!details || details.latitude === null || details.longitude === null) {
    return { lat: null, lng: null, matchedAddress: details?.formattedAddress ?? null, matchedName: details?.displayName ?? null, primaryType: null, types: [], addressSource: source };
  }
  return {
    lat: details.latitude, lng: details.longitude, matchedAddress: details.formattedAddress,
    matchedName: details.displayName, primaryType: details.primaryType, types: details.types,
    addressSource: source,
  };
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
    cap = balance !== null ? Math.max(0, Math.min(55, balance - 1)) : 20;
    console.log(`[c1-scan] live DFS balance = ${balance !== null ? '$' + balance.toFixed(2) : 'unknown'} -> effective cap = $${cap.toFixed(2)}`);
  }

  const baseRows = readInput();
  const baseDomains = new Set(baseRows.map((r) => r.domain.trim().toLowerCase()));
  const appendRows = readAppendCompanies(baseDomains);
  const droppedDomains = readDroppedDomains();
  const inputRows = prioritySort([...baseRows, ...appendRows]);
  const work = limit ? inputRows.slice(0, limit) : inputRows;
  const rollup = loadRollup();
  console.log(`[c1-scan] priority order applied: Ontario first, then Tier1 (reviews>=40 & capacity_signal) elsewhere, then the rest, then ${appendRows.length} tier-3 append rows (adlib_active, c1-final-list.csv).`);
  console.log(`[c1-scan] off-ICP skip set loaded: ${droppedDomains.size} domains (c1-dropped-domains.txt) — not-yet-scanned rows on this list will not consume budget.`);

  const supabase = getServerSupabase();
  const COST_PER_SCAN_ESTIMATE = 0.162;
  let cumulative = 0;
  // Recompute cumulative from any prior rollup rows (resume).
  for (const line of rollup.values()) {
    const cols = parseCsvLine(line);
    cumulative += Number(cols[19]) || 0;
  }
  console.log(`[c1-scan] resuming with cumulative=$${cumulative.toFixed(3)} from ${rollup.size} prior rows`);

  let scanned = 0, failed = 0, skippedAlready = 0, skippedOffIcp = 0;
  let stopReason = '';

  for (let i = 0; i < work.length; i++) {
    const row = work[i];
    const existing = rollup.get(row.company);
    if (existing) {
      const cols = parseCsvLine(existing);
      const status = cols[17];
      if (status === 'scanned' || status === 'failed' || status === 'skipped_off_icp') { skippedAlready++; continue; }
    }

    // 2026-08-26 ICP-audit correction: not-yet-scanned off-ICP domains are
    // excluded entirely — no Places call, no Supabase insert, no DFS spend.
    if (droppedDomains.has(row.domain.trim().toLowerCase())) {
      console.log(`
[${i + 1}/${work.length}] ${row.company} — SKIPPED (off-ICP per c1-dropped-domains.txt, not yet scanned)`);
      upsertRollup(rollup, {
        company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, null),
        city: row.city, state: row.state, country: row.country, street: row.street,
        full_address: row.full_address, matched_address: '', category_keyword: '',
        turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
        distance_phrase: distancePhrase(row.country), share_link: '', status: 'skipped_off_icp',
        failure_reason: 'ICP-audit correction 2026-08-26: confirmed off-ICP, excluded before spend', dfs_cost_usd: 0,
      });
      skippedOffIcp++;
      continue;
    }

    if (cumulative + COST_PER_SCAN_ESTIMATE > cap) {
      stopReason = `budget cap reached ($${cap.toFixed(2)}) before ${row.company} (cumulative=$${cumulative.toFixed(3)})`;
      break;
    }

    console.log(`\n[${i + 1}/${work.length}] ${row.company} (${row.city}, ${row.state})`);

    if (dryRun) {
      console.log(`  (dry-run) would scan — cumulative would become $${(cumulative + COST_PER_SCAN_ESTIMATE).toFixed(3)}`);
      cumulative += COST_PER_SCAN_ESTIMATE;
      continue;
    }

    const place = await resolvePlace(row);
    if (place.lat === null || place.lng === null) {
      console.log('  ✗ geocode miss — no usable Places match');
      upsertRollup(rollup, {
        company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, null),
        city: row.city, state: row.state, country: row.country, street: row.street,
        full_address: row.full_address, matched_address: '', category_keyword: '',
        turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
        distance_phrase: distancePhrase(row.country), share_link: '', status: 'failed',
        failure_reason: 'geocode miss (no Places match on name+address or address-only)', dfs_cost_usd: 0,
      });
      failed++;
      continue;
    }

    const category = keywordFromPlaces(place.primaryType, place.types)
      ?? keywordFromTaxonomy(row.keywords, row.industry)
      ?? `${row.industry || 'home services'} near me`;

    const email = `outreach-c1+${slugify(row.company)}@fourdots-outreach.local`;

    const { data: existingClientRaw } = await supabase
      .from('clients')
      .select('id')
      .eq('is_outreach_lead', true)
      .eq('pending_buyer_email', email)
      .maybeSingle<{ id: string }>();

    // Guard against an ORPHANED client: a row can exist with no complete
    // scan behind it if a prior run's process was killed between the
    // client insert and the scan finishing (a real failure mode hit
    // during this batch — SIGTERM lands after the insert's HTTP request
    // is already in flight server-side). Trusting client-existence alone
    // as "already done" silently produces a blank scanned row. Verify a
    // complete scan actually exists; if not, delete the orphan (cascades
    // to client_locations/tracked_keywords/scans/scan_points/share_links)
    // and fall through to a fresh insert + real scan.
    let existingClient = existingClientRaw;
    if (existingClient) {
      const { data: realScan } = await supabase
        .from('scans')
        .select('id')
        .eq('client_id', existingClient.id)
        .eq('status', 'complete')
        .maybeSingle<{ id: string }>();
      if (!realScan) {
        console.log('  ⚠ found an orphaned client (no complete scan) — deleting and rescanning fresh');
        await supabase.from('clients').delete().eq('id', existingClient.id);
        existingClient = null;
      }
    }

    let scanResult;
    let clientId: string;
    let dfsCostThisRow = 0;

    if (existingClient) {
      clientId = existingClient.id;
      console.log('  ↻ client already exists — reusing (will not re-scan; pulling last complete scan)');
    } else {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .insert({
          business_name: row.company,
          address: place.matchedAddress,
          latitude: place.lat,
          longitude: place.lng,
          service_radius_miles: 1.6,
          status: 'paused',
          billing_mode: 'agency_managed',
          is_outreach_lead: true,
          pending_buyer_email: email,
          industry: place.primaryType || row.industry,
        })
        .select('*')
        .single<ClientRow>();
      if (clientErr || !client) {
        console.log(`  ✗ client insert failed: ${clientErr?.message}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, place.matchedAddress),
          city: row.city, state: row.state, country: row.country, street: row.street,
          full_address: row.full_address, matched_address: place.matchedAddress ?? '', category_keyword: category,
          turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
          distance_phrase: distancePhrase(row.country), share_link: '', status: 'failed',
          failure_reason: `client insert: ${clientErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
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
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, place.matchedAddress),
          city: row.city, state: row.state, country: row.country, street: row.street,
          full_address: row.full_address, matched_address: place.matchedAddress ?? '', category_keyword: category,
          turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
          distance_phrase: distancePhrase(row.country), share_link: '', status: 'failed',
          failure_reason: `location insert: ${locErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
        failed++;
        continue;
      }

      const { data: kw, error: kwErr } = await supabase
        .from('tracked_keywords')
        .insert({ client_id: client.id, location_id: location.id, keyword: category, is_primary: true })
        .select('*')
        .single<TrackedKeywordRow>();
      if (kwErr || !kw) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ keyword insert failed: ${kwErr?.message}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, place.matchedAddress),
          city: row.city, state: row.state, country: row.country, street: row.street,
          full_address: row.full_address, matched_address: place.matchedAddress ?? '', category_keyword: category,
          turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
          distance_phrase: distancePhrase(row.country), share_link: '', status: 'failed',
          failure_reason: `keyword insert: ${kwErr?.message ?? 'no row'}`, dfs_cost_usd: 0,
        });
        failed++;
        continue;
      }

      scanResult = await runScanForLocation(supabase, {
        client: { id: client.id, business_name: row.company },
        location,
        keyword: { id: kw.id, keyword: category },
        scanType: 'on_demand',
        triggeredBy: null,
      });

      // Real cost regardless of ok/fail — read back from the scans row.
      if ('scanId' in scanResult && scanResult.scanId) {
        const { data: scanRow } = await supabase.from('scans').select('dfs_cost_cents').eq('id', scanResult.scanId).maybeSingle<{ dfs_cost_cents: number | null }>();
        dfsCostThisRow = (scanRow?.dfs_cost_cents ?? 0) / 100;
      }
      cumulative += dfsCostThisRow;

      if (!scanResult.ok) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ scan failed: ${scanResult.error}`);
        upsertRollup(rollup, {
          company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, place.matchedAddress),
          city: row.city, state: row.state, country: row.country, street: row.street,
          full_address: row.full_address, matched_address: place.matchedAddress ?? '', category_keyword: category,
          turfscore: '', rank_at_pin: '', rank_at_edge: '', edge_point: '',
          distance_phrase: distancePhrase(row.country), share_link: '', status: 'failed',
          failure_reason: `scan: ${scanResult.error}`, dfs_cost_usd: dfsCostThisRow,
        });
        failed++;
        continue;
      }
    }

    // Pull rank_at_pin (4,4) and rank_at_edge (4,0 — north, ~1.6mi/2.57km) + latest scan.
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

      const { data: existingLink } = await supabase.from('scan_share_links').select('id').eq('scan_id', scanRow2.id).order('created_at', { ascending: false }).limit(1).maybeSingle<{ id: string }>();
      if (existingLink) {
        shareUrl = `${APP_ORIGIN}/share/${existingLink.id}`;
      } else {
        const expiresAt = new Date(Date.now() + DEFAULT_SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { data: link } = await supabase.from('scan_share_links').insert({ scan_id: scanRow2.id, expires_at: expiresAt, cta_text: SHARE_CTA_TEXT, cta_url: SHARE_CTA_URL }).select('id').single<{ id: string }>();
        if (link) shareUrl = `${APP_ORIGIN}/share/${link.id}`;
      }
    }

    console.log(`  ✓ TurfScore ${turfScoreVal} · pin=${rankAtPin || 'unranked'} · edge=${rankAtEdge || 'unranked'} · keyword "${category}" · cost=$${dfsCostThisRow.toFixed(3)} · cumulative=$${cumulative.toFixed(3)}`);

    upsertRollup(rollup, {
      company: row.company, domain: row.domain, geo: row.geo, metro: deriveMetro(row, place.matchedAddress),
      city: row.city, state: row.state, country: row.country, street: row.street,
      full_address: row.full_address, matched_address: place.matchedAddress ?? '', category_keyword: category,
      turfscore: turfScoreVal, rank_at_pin: rankAtPin, rank_at_edge: rankAtEdge,
      edge_point: 'grid_x=4,grid_y=0 (north, ~1.6mi/2.57km from pin — actual TurfMap grid edge)',
      distance_phrase: distancePhrase(row.country), share_link: shareUrl, status: 'scanned',
      failure_reason: '', dfs_cost_usd: dfsCostThisRow,
    });
    scanned++;

    fs.writeFileSync(STATE_PATH, JSON.stringify({ cumulative, lastIdx: i, lastCompany: row.company, updatedAt: new Date().toISOString() }, null, 2));
  }

  console.log(`\n[c1-scan] DONE. scanned=${scanned} failed=${failed} skipped(already-done)=${skippedAlready} skipped(off-icp)=${skippedOffIcp} cumulative=$${cumulative.toFixed(3)} / cap $${cap.toFixed(2)}`);
  if (stopReason) console.log(`[c1-scan] STOPPED EARLY: ${stopReason}`);
}

main().catch((e) => {
  console.error('[c1-scan] fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
