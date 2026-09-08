/**
 * outreach-c2-apex-guardian-scan.ts — WS15 (2026-09-01): backfill the two
 * C2 platforms WS13 could not enumerate from their websites. Brands were
 * verified via press releases (source URLs recorded in
 * 06-status/WS15-apex-guardian-scans.md), suppression-checked, and are
 * scanned with the SAME production pipeline as outreach-c2-portfolio-scan.ts
 * (81-point grid, 1.6mi, desktop). One anchor location per brand, resolved
 * via Places Text Search with a city anchor from the press release.
 *
 * Budget cap: $3.00 hard (task budget), 6 scans expected (~$0.96).
 * Resume-safe via the same _c2-portfolio-progress.csv place_id set.
 * Appends to c2-portfolio-locations.csv; updates ONLY the Apex/Guardian
 * rows of c2-portfolio-rollup.csv in place (other platforms untouched).
 *
 * Run: npx tsx scripts/outreach-c2-apex-guardian-scan.ts [--cap 3.00] [--dry-run]
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

// GOOGLE_PLACES_API_KEY in .env.local is quote-wrapped; dotenv strips
// surrounding quotes on parse, but belt-and-suspenders per the task note:
for (const k of ['GOOGLE_PLACES_API_KEY']) {
  const v = process.env[k];
  if (v && /^".*"$/.test(v)) process.env[k] = v.slice(1, -1);
}

import { getServerSupabase } from '../lib/supabase/server';
import { searchPlaces, getPlaceDetails } from '../lib/google/places';
import { runScanForLocation } from '../lib/scans/runScan';
import type { ClientRow, ClientLocationRow, TrackedKeywordRow } from '../lib/supabase/types';
import { normalizeIndustry } from '../lib/industries/normalize';

const OUTREACH_ROOT = path.resolve(process.cwd(), '../fourdots-outreach');
const RESULTS_DIR = path.join(OUTREACH_ROOT, '02-turfscan');
const LOCATIONS_PATH = path.join(RESULTS_DIR, 'c2-portfolio-locations.csv');
const ROLLUP_PATH = path.join(RESULTS_DIR, 'c2-portfolio-rollup.csv');
const PROGRESS_PATH = path.join(RESULTS_DIR, '_c2-portfolio-progress.csv');
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

const DEFAULT_SHARE_DAYS = 90;
const SHARE_CTA_TEXT = 'See your full territory map';
const SHARE_CTA_URL = 'https://localleadmachine.io/';
const COST_PER_SCAN_ESTIMATE = 0.162;
const HARD_CAP_DEFAULT = 3.0;

// ─── Verified targets (evidence URLs in WS15 status doc) ──────────────
// keyword rules match WS13: HVAC platform brands -> trade from name
// (none of these names say plumb/electric -> "hvac company near me");
// Guardian -> per this task's verbatim instruction "restoration company
// near me" matched to the brands' actual trade (damage restoration).
type Target = {
  platform: string; brand: string; query: string; keyword: string;
  /** name-match anchor for plausibility (press-release brand name) */
  matchName: string;
};
const TARGETS: Target[] = [
  { platform: 'Apex Service Partners', brand: 'Frank Gay Services', matchName: 'Frank Gay',
    query: 'Frank Gay Services plumbing HVAC electrical Orlando FL', keyword: 'hvac company near me' },
  { platform: 'Apex Service Partners', brand: 'Best Home Services', matchName: 'Best Home Services',
    query: 'Best Home Services HVAC plumbing electrical Naples FL', keyword: 'hvac company near me' },
  { platform: 'Apex Service Partners', brand: 'AB May', matchName: 'AB May',
    query: 'AB May heating cooling plumbing electrical Kansas City MO', keyword: 'hvac company near me' },
  { platform: 'Guardian Restoration Partners', brand: 'DryLux Restoration', matchName: 'DryLux',
    query: 'DryLux Restoration water damage restoration Gilbert AZ', keyword: 'restoration company near me' },
  { platform: 'Guardian Restoration Partners', brand: 'Quick Dry Restoration', matchName: 'Quick Dry',
    query: 'Quick Dry Restoration water damage Boise ID', keyword: 'restoration company near me' },
  { platform: 'Guardian Restoration Partners', brand: 'Spartan Emergency Water Removal', matchName: 'Spartan',
    query: 'Spartan Emergency Water Removal Fredericksburg VA', keyword: 'restoration company near me' },
];

// n_brands_found per platform for the rollup (verified via press releases,
// includes brands not scanned: Korte Does It All, Haley Mechanical for
// Apex; Dry Kings, Midwest Restoration for Guardian).
const BRANDS_FOUND: Record<string, number> = {
  'Apex Service Partners': 5,
  'Guardian Restoration Partners': 5,
};

// ─── CSV helpers (same as c2 portfolio script) ────────────────────────
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
function extractCity(address: string | null): string {
  if (!address) return '';
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 3] || parts[0] || '';
  return parts[0] ?? '';
}

// ─── Progress (shared file with WS13 run) ─────────────────────────────
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
  if (!fs.existsSync(PROGRESS_PATH)) fs.writeFileSync(PROGRESS_PATH, 'place_id\n');
  fs.appendFileSync(PROGRESS_PATH, `${csvField(placeId)}\n`);
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

// ─── Rollup: update ONLY our two platform rows in place ───────────────
function updateRollupRow(platform: string, s: {
  nBrandsFound: number; nScanned: number; nFailed: number; nWeak: number;
  nAbsent: number; worstCity: string; shareLinks: string[];
}) {
  const lines = fs.readFileSync(ROLLUP_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  const newLine = [
    csvField(platform), s.nBrandsFound, s.nScanned, s.nFailed, s.nWeak, s.nAbsent,
    csvField(s.worstCity), csvField(s.shareLinks.slice(0, 3).join(' | ')),
  ].join(',');
  let replaced = false;
  for (let i = 1; i < lines.length; i++) {
    if (parseCsvLine(lines[i])[0] === platform) { lines[i] = newLine; replaced = true; break; }
  }
  if (!replaced) lines.push(newLine);
  fs.writeFileSync(ROLLUP_PATH, lines.join('\n') + '\n');
}

// ─── DFS balance probe (free) ─────────────────────────────────────────
async function fetchDfsBalance(): Promise<number | null> {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) return null;
  const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
    method: 'GET', headers: { Authorization: auth },
  });
  if (!res.ok) return null;
  const json = await res.json();
  try { return json.tasks[0].result[0].money.balance as number; } catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const capIdx = args.indexOf('--cap');
  const dryRun = args.includes('--dry-run');
  const cap = capIdx !== -1 ? Number(args[capIdx + 1]) : HARD_CAP_DEFAULT;
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  const balance = await fetchDfsBalance();
  console.log(`[ws15] DFS balance = ${balance !== null ? '$' + balance.toFixed(2) : 'unknown'} · cap this run = $${cap.toFixed(2)}`);

  const supabase = getServerSupabase();
  const progress = loadProgress();
  let cumulative = 0;

  type Stats = { nBrandsFound: number; nScanned: number; nFailed: number; nWeak: number; nAbsent: number; worstCity: string; shareLinks: string[]; worstRank: number };
  const statsBy = new Map<string, Stats>();
  const statFor = (p: string): Stats => {
    if (!statsBy.has(p)) statsBy.set(p, { nBrandsFound: BRANDS_FOUND[p] ?? 0, nScanned: 0, nFailed: 0, nWeak: 0, nAbsent: 0, worstCity: '', shareLinks: [], worstRank: -1 });
    return statsBy.get(p)!;
  };

  for (const t of TARGETS) {
    if (only && !t.brand.toLowerCase().includes(only.toLowerCase())) continue;
    const stats = statFor(t.platform);
    console.log(`\n[ws15] === ${t.platform} / ${t.brand} ===`);
    if (cumulative + COST_PER_SCAN_ESTIMATE > cap) {
      console.log(`  budget cap reached ($${cap.toFixed(2)}) — stopping before ${t.brand}`);
      break;
    }
    if (dryRun) {
      cumulative += COST_PER_SCAN_ESTIMATE;
      console.log(`  (dry-run) query "${t.query}" keyword "${t.keyword}" — cumulative would be $${cumulative.toFixed(3)}`);
      continue;
    }

    // Resolve via Places (city-anchored press-release query). ONE retry
    // max: drop the trade words, keep brand + city.
    let search = await searchPlaces({ query: t.query, latitude: null, longitude: null, maxResults: 3, regionCode: 'US' });
    if (search.candidates.length === 0) {
      const fallback = t.query.split(' ').filter((w, i, a) => i < 3 || i >= a.length - 2).join(' ');
      search = await searchPlaces({ query: fallback, latitude: null, longitude: null, maxResults: 3, regionCode: 'US' });
    }
    // Normalized compare: "A.B. May" vs "AB May" both -> "abmay" (the
    // punctuation mismatch cost the first AB May attempt its match).
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let details: Awaited<ReturnType<typeof getPlaceDetails>> = null;
    for (const cand of search.candidates) {
      const d = await getPlaceDetails(cand.placeId);
      if (!d || d.latitude === null || d.longitude === null) continue;
      if (norm(d.displayName ?? '').includes(norm(t.matchName))) { details = d; break; }
    }
    if (!details) {
      console.log('  ✗ no plausible Places match — recording failed, no spend');
      appendLocationRow({ platform: t.platform, brand: t.brand, matched_name: '', matched_address: '', category_keyword: t.keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: 'geocode miss (no plausible Places match)' });
      stats.nFailed++;
      updateRollupRow(t.platform, stats);
      continue;
    }
    if (progress.has(details.placeId)) {
      console.log(`  ↻ place ${details.placeId} already in progress file — skipping`);
      continue;
    }
    console.log(`  matched: ${details.displayName} — ${details.formattedAddress}`);

    const email = `outreach-c2+${slugify(t.platform)}-${slugify(t.brand)}-${details.placeId.slice(-6)}@fourdots-outreach.local`;

    // Orphan-guard (same as WS13): reuse only a complete scan on this keyword.
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
        matches = (kwRow?.keyword ?? '').trim().toLowerCase() === t.keyword.toLowerCase();
      }
      if (matches) { clientId = existingClientRaw.id; console.log('  ↻ already scanned with this keyword — reusing'); }
      else { console.log('  ⚠ orphaned/stale client — deleting and scanning fresh'); await supabase.from('clients').delete().eq('id', existingClientRaw.id); }
    }

    if (!clientId) {
      const { data: client, error: clientErr } = await supabase
        .from('clients').insert({
          business_name: details.displayName ?? t.brand, address: details.formattedAddress, latitude: details.latitude,
          longitude: details.longitude, service_radius_miles: 1.6, status: 'paused', billing_mode: 'agency_managed',
          is_outreach_lead: true, pending_buyer_email: email, industry: normalizeIndustry(null, { businessName: t.brand, keyword: t.keyword }),
        }).select('*').single<ClientRow>();
      if (clientErr || !client) {
        console.log(`  ✗ client insert failed: ${clientErr?.message}`);
        appendLocationRow({ platform: t.platform, brand: t.brand, matched_name: details.displayName ?? '', matched_address: details.formattedAddress ?? '', category_keyword: t.keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `client insert: ${clientErr?.message ?? 'no row'}` });
        appendProgress(details.placeId);
        stats.nFailed++;
        updateRollupRow(t.platform, stats);
        continue;
      }
      clientId = client.id;

      const { data: location, error: locErr } = await supabase
        .from('client_locations').insert({
          client_id: client.id, is_primary: true, label: details.displayName ?? t.brand, address: details.formattedAddress,
          latitude: details.latitude, longitude: details.longitude, service_radius_miles: 1.6,
          google_place_id: details.placeId, google_place_match_status: 'auto',
        }).select('*').single<ClientLocationRow>();
      if (locErr || !location) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ location insert failed: ${locErr?.message}`);
        appendLocationRow({ platform: t.platform, brand: t.brand, matched_name: details.displayName ?? '', matched_address: details.formattedAddress ?? '', category_keyword: t.keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `location insert: ${locErr?.message ?? 'no row'}` });
        appendProgress(details.placeId);
        stats.nFailed++;
        updateRollupRow(t.platform, stats);
        continue;
      }

      const { data: kw, error: kwErr } = await supabase
        .from('tracked_keywords').insert({ client_id: client.id, location_id: location.id, keyword: t.keyword, is_primary: true }).select('*').single<TrackedKeywordRow>();
      if (kwErr || !kw) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ keyword insert failed: ${kwErr?.message}`);
        appendLocationRow({ platform: t.platform, brand: t.brand, matched_name: details.displayName ?? '', matched_address: details.formattedAddress ?? '', category_keyword: t.keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: 0, status: 'failed', failure_reason: `keyword insert: ${kwErr?.message ?? 'no row'}` });
        appendProgress(details.placeId);
        stats.nFailed++;
        updateRollupRow(t.platform, stats);
        continue;
      }

      const scanResult = await runScanForLocation(supabase, {
        client: { id: client.id, business_name: details.displayName ?? t.brand }, location,
        keyword: { id: kw.id, keyword: t.keyword }, scanType: 'on_demand', triggeredBy: null,
      });
      if ('scanId' in scanResult && scanResult.scanId) {
        const { data: scanRow } = await supabase.from('scans').select('dfs_cost_cents').eq('id', scanResult.scanId).maybeSingle<{ dfs_cost_cents: number | null }>();
        dfsCostThisRow = (scanRow?.dfs_cost_cents ?? 0) / 100;
      }
      cumulative += dfsCostThisRow;
      if (!scanResult.ok) {
        await supabase.from('clients').delete().eq('id', client.id);
        console.log(`  ✗ scan failed: ${scanResult.error}`);
        appendLocationRow({ platform: t.platform, brand: t.brand, matched_name: details.displayName ?? '', matched_address: details.formattedAddress ?? '', category_keyword: t.keyword, turfscore: '', rank_at_pin: '', in_top3: '', absent: true, share_link: '', dfs_cost_usd: dfsCostThisRow, status: 'failed', failure_reason: `scan: ${scanResult.error}` });
        appendProgress(details.placeId);
        stats.nFailed++;
        updateRollupRow(t.platform, stats);
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
    const weak = !inTop3;

    console.log(`  ✓ TurfScore ${turfScoreVal} · pin=${rankAtPin || 'absent'} · weak=${weak} · cost=$${dfsCostThisRow.toFixed(3)} · cumulative=$${cumulative.toFixed(3)}`);
    console.log(`  share: ${shareUrl}`);

    appendLocationRow({
      platform: t.platform, brand: t.brand, matched_name: details.displayName ?? '', matched_address: details.formattedAddress ?? '',
      category_keyword: t.keyword, turfscore: turfScoreVal, rank_at_pin: rankAtPin, in_top3: inTop3, absent,
      share_link: shareUrl, dfs_cost_usd: dfsCostThisRow, status: 'scanned', failure_reason: '',
    });
    appendProgress(details.placeId);

    stats.nScanned++;
    if (weak) stats.nWeak++;
    if (absent) stats.nAbsent++;
    if (shareUrl) stats.shareLinks.push(shareUrl);
    const rankSort = absent ? 999 : Number(rankAtPin);
    if (rankSort > stats.worstRank) {
      stats.worstRank = rankSort;
      stats.worstCity = extractCity(details.formattedAddress);
    }
    updateRollupRow(t.platform, stats);
  }

  console.log(`\n[ws15] DONE. cumulative=$${cumulative.toFixed(3)} / cap $${cap.toFixed(2)}`);
  for (const [p, s] of statsBy) {
    console.log(`  ${p}: brands=${s.nBrandsFound} scanned=${s.nScanned} failed=${s.nFailed} weak=${s.nWeak} absent=${s.nAbsent} worst_city=${s.worstCity}`);
  }
  const after = await fetchDfsBalance();
  console.log(`[ws15] DFS balance after = ${after !== null ? '$' + after.toFixed(2) : 'unknown'}`);
}

main().catch((e) => {
  console.error('[ws15] fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
