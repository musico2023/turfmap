/**
 * Outreach-lead enrichment.
 *
 * TWO MODES:
 *
 * 1) Single-pass (legacy):
 *    Takes a raw lead CSV, does Places lookup + DFS scan + share-link
 *    creation in one shot.
 *      npm run enrich:leads -- --input <leads.csv> --output <out.csv> \
 *        --tag llm,llm-form-submit
 *
 * 2) Two-phase via preview (recommended):
 *    Phase 1: scripts/preview-leads.ts does only the Places lookup
 *    and emits a review CSV with match details + derived keyword +
 *    confidence flag. Operator reviews/edits in a spreadsheet (override
 *    keywords, mark skip='y' for bad matches).
 *    Phase 2: this script reads the reviewed CSV via --from-preview
 *    and runs only the DFS scans + share-link generation on rows the
 *    operator confirmed.
 *      npm run preview:leads -- --input <leads.csv> --output <preview.csv>
 *      # (operator edits preview.csv)
 *      npm run enrich:leads -- --from-preview <preview.csv> --output <out.csv>
 *
 * Flags:
 *   --from-preview <path>   reviewed-preview CSV — phase 2 mode
 *   --input   <path>        raw lead CSV — single-pass mode
 *   --output  <path>        output CSV (required, both modes)
 *   --limit   <N>           cap rows processed
 *   --tag     <name,…>      single-pass: only these tags
 *   --skip-tag <name,…>     single-pass: exclude these tags
 *   --dry-run               list what would be processed; no API calls
 *   --share-cta-text  <s>   override the share-link's CTA headline
 *   --share-cta-url   <s>   override the share-link's CTA destination
 *   --share-days      <N>   share-link expiry in days (default: 90)
 *
 * Cost:
 *   - Single-pass:    ~$0.19 per lead (Places + DFS)
 *   - From-preview:   ~$0.16 per scanned row (DFS only — Places paid in phase 1)
 *
 * Idempotency: rows are matched by lead email — re-runs skip leads
 * we've already enriched (look for an existing clients row tagged
 * is_outreach_lead=true + matching pending_buyer_email).
 *
 * Each enriched row writes:
 *   - 1 clients row (is_outreach_lead=true, status='paused' so the
 *     row never appears in agency views or recurring crons)
 *   - 1 client_locations row (primary)
 *   - 1 tracked_keywords row (the auto-derived keyword)
 *   - 1 scans row + 81 scan_points rows
 *   - 1 scan_share_links row (90-day expiry by default)
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { searchPlaces, getPlaceDetails } from '../lib/google/places';
import { runScanForLocation } from '../lib/scans/runScan';
import type {
  ClientRow,
  ClientLocationRow,
  TrackedKeywordRow,
} from '../lib/supabase/types';

type Lead = {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string;
  businessName: string;
  tags: string[];
};

type EnrichmentResult = {
  email: string;
  businessName: string;
  status: 'enriched' | 'skipped' | 'failed' | 'already_enriched';
  reason?: string;
  matchedAddress?: string | null;
  matchedCategory?: string | null;
  keyword?: string | null;
  turfScore?: number | null;
  turfReach?: number | null;
  turfRank?: number | null;
  topCompetitor?: string | null;
  shareUrl?: string | null;
  costCents?: number;
};

const DEFAULT_SHARE_DAYS = 90;
const DEFAULT_SHARE_CTA_TEXT = "See the full picture — get a TurfScan for your business";
const DEFAULT_SHARE_CTA_URL = 'https://turfmap.ai';
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

async function main() {
  const args = parseArgs();

  // Phase 2: reviewed-preview CSV → DFS scans + share links only.
  if (args.fromPreview) {
    return mainFromPreview(args);
  }

  if (!args.input || !args.output) {
    console.error(
      'Usage:\n  Single-pass:   npm run enrich:leads -- --input <leads.csv> --output <csv> [--tag a,b] [--skip-tag c,d]\n  From preview:  npm run enrich:leads -- --from-preview <preview.csv> --output <csv>'
    );
    process.exit(1);
  }
  if (!process.env.GOOGLE_PLACES_API_KEY && !args.dryRun) {
    console.error('GOOGLE_PLACES_API_KEY is not set in .env.local.');
    process.exit(1);
  }

  const leads = readLeads(args.input);
  const filtered = leads.filter((l) => {
    if (args.tags && !l.tags.some((t) => args.tags!.includes(t))) return false;
    if (args.skipTags && l.tags.some((t) => args.skipTags!.includes(t))) {
      return false;
    }
    if (!l.email || !l.businessName) return false;
    return true;
  });
  const work = args.limit ? filtered.slice(0, args.limit) : filtered;

  console.log(
    `[enrich-leads] read=${leads.length} after-filter=${filtered.length} processing=${work.length}${args.dryRun ? ' (dry-run)' : ''}`
  );

  if (args.dryRun) {
    for (const l of work) {
      console.log(`  - ${l.email} / ${l.businessName} [${l.tags.join(', ')}]`);
    }
    console.log(
      `\nEstimated cost if run for real: ~$${(work.length * 0.19).toFixed(2)}`
    );
    return;
  }

  const supabase = getServerSupabase();
  const results: EnrichmentResult[] = [];
  let totalCostCents = 0;

  for (let i = 0; i < work.length; i++) {
    const lead = work[i];
    const tag = `[${i + 1}/${work.length}] ${lead.businessName} (${lead.email})`;
    console.log(tag);

    // Idempotency — skip if we already enriched this lead.
    const { data: existing } = await supabase
      .from('clients')
      .select('id, public_id')
      .eq('is_outreach_lead', true)
      .eq('pending_buyer_email', lead.email)
      .maybeSingle<{ id: string; public_id: string }>();
    if (existing) {
      const restored = await loadExistingResult(supabase, {
        clientId: existing.id,
        email: lead.email,
        businessName: lead.businessName,
      });
      console.log(
        `  ↻ already enriched (client ${existing.public_id}) — TurfScore ${restored.turfScore ?? 'n/a'} · ${restored.shareUrl ?? '(no link)'}`
      );
      results.push(restored);
      continue;
    }

    const result = await enrichOne({
      supabase,
      lead,
      shareDays: args.shareDays ?? DEFAULT_SHARE_DAYS,
      shareCtaText: args.shareCtaText ?? DEFAULT_SHARE_CTA_TEXT,
      shareCtaUrl: args.shareCtaUrl ?? DEFAULT_SHARE_CTA_URL,
    });
    results.push(result);
    if (result.costCents) totalCostCents += result.costCents;

    if (result.status === 'enriched') {
      console.log(
        `  ✓ TurfScore ${result.turfScore} · top: ${result.topCompetitor ?? '(none)'} · ${result.shareUrl}`
      );
    } else {
      console.log(`  ${result.status === 'failed' ? '✗' : '–'} ${result.reason ?? result.status}`);
    }
  }

  writeResults(args.output, results);
  console.log(
    `\n[enrich-leads] done. enriched=${results.filter((r) => r.status === 'enriched').length} skipped=${results.filter((r) => r.status === 'skipped').length} failed=${results.filter((r) => r.status === 'failed').length} already=${results.filter((r) => r.status === 'already_enriched').length}`
  );
  console.log(`Total cost: $${(totalCostCents / 100).toFixed(2)}`);
  console.log(`Output: ${args.output}`);
}

// ─── Phase 2: from-preview mode ──────────────────────────────────────────

type PreviewRow = {
  email: string;
  business_name: string;
  match_status: string;
  place_id: string;
  matched_name: string;
  matched_address: string;
  matched_category: string;
  matched_lat: string;
  matched_lng: string;
  derived_keyword: string;
  keyword_override: string;
  skip: string;
};

async function mainFromPreview(args: Args) {
  if (!args.output) {
    console.error('--from-preview requires --output');
    process.exit(1);
  }
  const rows = readPreviewCsv(args.fromPreview);
  const eligible = rows.filter(
    (r) => r.match_status === 'matched' && !truthy(r.skip)
  );
  const work = args.limit ? eligible.slice(0, args.limit) : eligible;

  console.log(
    `[enrich-leads] from-preview rows=${rows.length} eligible=${eligible.length} processing=${work.length}${args.dryRun ? ' (dry-run)' : ''}`
  );

  if (args.dryRun) {
    for (const r of work.slice(0, 25)) {
      const kw = (r.keyword_override || r.derived_keyword || '(no keyword)').trim();
      console.log(`  - ${r.business_name} → "${kw}"  [${r.email}]`);
    }
    if (work.length > 25) console.log(`  …and ${work.length - 25} more`);
    console.log(`\nEstimated DFS cost: ~$${(work.length * 0.16).toFixed(2)}`);
    return;
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.error('GOOGLE_PLACES_API_KEY is not set in .env.local.');
    process.exit(1);
  }

  const supabase = getServerSupabase();
  const results: EnrichmentResult[] = [];
  let totalCostCents = 0;

  for (let i = 0; i < work.length; i++) {
    const r = work[i];
    const tag = `[${i + 1}/${work.length}] ${r.business_name} (${r.email})`;
    console.log(tag);

    // Idempotency — skip if we already enriched this lead.
    const { data: existing } = await supabase
      .from('clients')
      .select('id, public_id')
      .eq('is_outreach_lead', true)
      .eq('pending_buyer_email', r.email)
      .maybeSingle<{ id: string; public_id: string }>();
    if (existing) {
      const restored = await loadExistingResult(supabase, {
        clientId: existing.id,
        email: r.email,
        businessName: r.business_name,
      });
      console.log(
        `  ↻ already enriched (client ${existing.public_id}) — TurfScore ${restored.turfScore ?? 'n/a'} · ${restored.shareUrl ?? '(no link)'}`
      );
      results.push(restored);
      continue;
    }

    const result = await enrichFromPreviewedRow({
      supabase,
      row: r,
      shareDays: args.shareDays ?? DEFAULT_SHARE_DAYS,
      shareCtaText: args.shareCtaText ?? DEFAULT_SHARE_CTA_TEXT,
      shareCtaUrl: args.shareCtaUrl ?? DEFAULT_SHARE_CTA_URL,
    });
    results.push(result);
    if (result.costCents) totalCostCents += result.costCents;

    if (result.status === 'enriched') {
      console.log(
        `  ✓ TurfScore ${result.turfScore} · top: ${result.topCompetitor ?? '(none)'} · ${result.shareUrl}`
      );
    } else {
      console.log(`  ${result.status === 'failed' ? '✗' : '–'} ${result.reason ?? result.status}`);
    }
  }

  writeResults(args.output, results);
  console.log(
    `\n[enrich-leads] done. enriched=${results.filter((r) => r.status === 'enriched').length} skipped=${results.filter((r) => r.status === 'skipped').length} failed=${results.filter((r) => r.status === 'failed').length} already=${results.filter((r) => r.status === 'already_enriched').length}`
  );
  console.log(`Total cost: $${(totalCostCents / 100).toFixed(2)}`);
  console.log(`Output: ${args.output}`);
}

async function enrichFromPreviewedRow(args: {
  supabase: ReturnType<typeof getServerSupabase>;
  row: PreviewRow;
  shareDays: number;
  shareCtaText: string;
  shareCtaUrl: string;
}): Promise<EnrichmentResult> {
  const { supabase, row } = args;
  const businessName = row.business_name.trim();
  const keyword = (row.keyword_override || row.derived_keyword).trim().toLowerCase();
  if (!keyword) {
    return {
      email: row.email,
      businessName,
      status: 'skipped',
      reason: 'no keyword (derived empty + no override)',
    };
  }
  const lat = Number(row.matched_lat);
  const lng = Number(row.matched_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      email: row.email,
      businessName,
      status: 'skipped',
      reason: 'matched lat/lng missing or invalid',
    };
  }

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: businessName,
      address: row.matched_address || null,
      latitude: lat,
      longitude: lng,
      service_radius_miles: 1.6,
      status: 'paused',
      billing_mode: 'agency_managed',
      is_outreach_lead: true,
      pending_buyer_email: row.email,
      industry: row.matched_category || null,
    })
    .select('*')
    .single<ClientRow>();
  if (clientErr || !client) {
    return {
      email: row.email,
      businessName,
      status: 'failed',
      reason: `client insert: ${clientErr?.message ?? 'no row'}`,
    };
  }

  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: businessName,
      address: row.matched_address || null,
      latitude: lat,
      longitude: lng,
      service_radius_miles: 1.6,
      google_place_id: row.place_id || null,
      google_place_match_status: 'manual',
    })
    .select('*')
    .single<ClientLocationRow>();
  if (locErr || !location) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: row.email,
      businessName,
      status: 'failed',
      reason: `location insert: ${locErr?.message ?? 'no row'}`,
    };
  }

  const { data: kw, error: kwErr } = await supabase
    .from('tracked_keywords')
    .insert({
      client_id: client.id,
      location_id: location.id,
      keyword,
      is_primary: true,
    })
    .select('*')
    .single<TrackedKeywordRow>();
  if (kwErr || !kw) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: row.email,
      businessName,
      status: 'failed',
      reason: `keyword insert: ${kwErr?.message ?? 'no row'}`,
    };
  }

  const scanResult = await runScanForLocation(supabase, {
    client: { id: client.id, business_name: businessName },
    location,
    keyword: { id: kw.id, keyword },
    scanType: 'on_demand',
    triggeredBy: null,
  });
  if (!scanResult.ok) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: row.email,
      businessName,
      status: 'failed',
      reason: `scan: ${scanResult.error}`,
      keyword,
    };
  }

  const topCompetitor = await findTopCompetitor(
    supabase,
    scanResult.scanId,
    businessName
  );
  const expiresAt = new Date(
    Date.now() + args.shareDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: link, error: linkErr } = await supabase
    .from('scan_share_links')
    .insert({
      scan_id: scanResult.scanId,
      expires_at: expiresAt,
      cta_text: args.shareCtaText,
      cta_url: args.shareCtaUrl,
    })
    .select('id')
    .single<{ id: string }>();
  if (linkErr || !link) {
    return {
      email: row.email,
      businessName,
      status: 'failed',
      reason: `share link: ${linkErr?.message ?? 'no row'}`,
      keyword,
      turfScore: scanResult.turfScore,
      turfReach: scanResult.turfReach,
      turfRank: scanResult.turfRank,
      topCompetitor,
      costCents: scanResult.dfsCostCents,
    };
  }

  return {
    email: row.email,
    businessName,
    status: 'enriched',
    matchedAddress: row.matched_address || null,
    matchedCategory: row.matched_category || null,
    keyword,
    turfScore: scanResult.turfScore,
    turfReach: scanResult.turfReach,
    turfRank: scanResult.turfRank,
    topCompetitor,
    shareUrl: `${APP_ORIGIN}/share/${link.id}`,
    costCents: scanResult.dfsCostCents,
  };
}

/**
 * Reconstruct a full EnrichmentResult for a lead we've already
 * enriched (idempotency / resume path). Joins clients → scans →
 * scan_points → scan_share_links so the output CSV is fully
 * populated even when most rows came from prior runs.
 */
async function loadExistingResult(
  supabase: ReturnType<typeof getServerSupabase>,
  args: { clientId: string; email: string; businessName: string }
): Promise<EnrichmentResult> {
  const base: EnrichmentResult = {
    email: args.email,
    businessName: args.businessName,
    status: 'already_enriched',
  };

  // Pull the clients row's primary location address + category for
  // the CSV columns.
  const { data: client } = await supabase
    .from('clients')
    .select('address, industry')
    .eq('id', args.clientId)
    .maybeSingle<{ address: string | null; industry: string | null }>();
  if (client) {
    base.matchedAddress = client.address;
    base.matchedCategory = client.industry;
  }

  // Latest complete scan for the client → score family + keyword.
  const { data: scan } = await supabase
    .from('scans')
    .select('id, turf_score, turf_reach, turf_rank, keyword_id')
    .eq('client_id', args.clientId)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      turf_score: number | null;
      turf_reach: number | null;
      turf_rank: number | null;
      keyword_id: string | null;
    }>();
  if (!scan) return base;

  base.turfScore = scan.turf_score;
  base.turfReach = scan.turf_reach;
  base.turfRank = scan.turf_rank;
  base.topCompetitor = await findTopCompetitor(
    supabase,
    scan.id,
    args.businessName
  );

  if (scan.keyword_id) {
    const { data: kw } = await supabase
      .from('tracked_keywords')
      .select('keyword')
      .eq('id', scan.keyword_id)
      .maybeSingle<{ keyword: string }>();
    base.keyword = kw?.keyword ?? null;
  }

  // Most-recent share link for that scan.
  const { data: link } = await supabase
    .from('scan_share_links')
    .select('id')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (link) base.shareUrl = `${APP_ORIGIN}/share/${link.id}`;

  return base;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'x';
}

function readPreviewCsv(filePath: string): PreviewRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h === name);
  const KEYS: Array<keyof PreviewRow> = [
    'email',
    'business_name',
    'match_status',
    'place_id',
    'matched_name',
    'matched_address',
    'matched_category',
    'matched_lat',
    'matched_lng',
    'derived_keyword',
    'keyword_override',
    'skip',
  ];
  const indices = Object.fromEntries(KEYS.map((k) => [k, idx(k)])) as Record<
    keyof PreviewRow,
    number
  >;
  const rows: PreviewRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const r: Partial<PreviewRow> = {};
    for (const k of KEYS) {
      r[k] = (indices[k] >= 0 ? cells[indices[k]] : '') ?? '';
    }
    rows.push(r as PreviewRow);
  }
  return rows;
}

// ─── Single-pass mode (legacy) ───────────────────────────────────────────

async function enrichOne(args: {
  supabase: ReturnType<typeof getServerSupabase>;
  lead: Lead;
  shareDays: number;
  shareCtaText: string;
  shareCtaUrl: string;
}): Promise<EnrichmentResult> {
  const { supabase, lead } = args;
  let costCents = 0;

  // 1. Find the business via Google Places (no location bias — global
  //    name search).
  const search = await searchPlaces({
    query: lead.businessName,
    latitude: null,
    longitude: null,
    maxResults: 1,
  });
  costCents += search.costCents;
  const candidate = search.candidates[0];
  if (!candidate) {
    return {
      email: lead.email,
      businessName: lead.businessName,
      status: 'skipped',
      reason: 'no Google Places match',
      costCents,
    };
  }

  // 2. Place Details for full data.
  const details = await getPlaceDetails(candidate.placeId);
  if (!details) {
    return {
      email: lead.email,
      businessName: lead.businessName,
      status: 'skipped',
      reason: 'place details fetch failed',
      costCents,
    };
  }
  costCents += details.costCents;

  if (details.latitude === null || details.longitude === null) {
    return {
      email: lead.email,
      businessName: lead.businessName,
      status: 'skipped',
      reason: 'matched place has no coordinates',
      costCents,
    };
  }

  // 3. Derive a keyword from the primary GBP category. DFS geo-locates
  //    via lat/lng so a plain "plumber" works without a city in the
  //    string. Skip if we have neither a primary type nor types
  //    fallback — too vague to scan reliably.
  const keyword = deriveKeyword(details.primaryType, details.types);
  if (!keyword) {
    return {
      email: lead.email,
      businessName: lead.businessName,
      status: 'skipped',
      reason: 'no usable category for keyword derivation',
      costCents,
      matchedAddress: details.formattedAddress,
    };
  }

  // 4. Insert the clients row. is_outreach_lead=true hides it from
  //    agency UI + crons. status='paused' keeps it out of any other
  //    surfaces that filter on status.
  const businessName = lead.businessName.trim();
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: businessName,
      address: details.formattedAddress,
      latitude: details.latitude,
      longitude: details.longitude,
      service_radius_miles: 1.6,
      status: 'paused',
      billing_mode: 'agency_managed',
      is_outreach_lead: true,
      pending_buyer_email: lead.email,
      industry: details.primaryType,
    })
    .select('*')
    .single<ClientRow>();
  if (clientErr || !client) {
    return {
      email: lead.email,
      businessName,
      status: 'failed',
      reason: `client insert: ${clientErr?.message ?? 'no row'}`,
      costCents,
    };
  }

  // 5. Insert primary location.
  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: businessName,
      address: details.formattedAddress,
      latitude: details.latitude,
      longitude: details.longitude,
      service_radius_miles: 1.6,
      google_place_id: details.placeId,
      google_place_match_status: 'auto',
    })
    .select('*')
    .single<ClientLocationRow>();
  if (locErr || !location) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: lead.email,
      businessName,
      status: 'failed',
      reason: `location insert: ${locErr?.message ?? 'no row'}`,
      costCents,
    };
  }

  // 6. Insert tracked keyword.
  const { data: kw, error: kwErr } = await supabase
    .from('tracked_keywords')
    .insert({
      client_id: client.id,
      location_id: location.id,
      keyword,
      is_primary: true,
    })
    .select('*')
    .single<TrackedKeywordRow>();
  if (kwErr || !kw) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: lead.email,
      businessName,
      status: 'failed',
      reason: `keyword insert: ${kwErr?.message ?? 'no row'}`,
      costCents,
    };
  }

  // 7. Run the scan. scan_type='on_demand' matches the constraint
  //    in migration 0001 (scheduled | on_demand).
  const scanResult = await runScanForLocation(supabase, {
    client: { id: client.id, business_name: businessName },
    location,
    keyword: { id: kw.id, keyword },
    scanType: 'on_demand',
    triggeredBy: null,
  });
  if (!scanResult.ok) {
    await supabase.from('clients').delete().eq('id', client.id);
    return {
      email: lead.email,
      businessName,
      status: 'failed',
      reason: `scan: ${scanResult.error}`,
      costCents,
      matchedAddress: details.formattedAddress,
      matchedCategory: details.primaryType,
      keyword,
    };
  }
  costCents += scanResult.dfsCostCents;

  // 8. Top competitor — aggregate by name across all scan_points.
  const topCompetitor = await findTopCompetitor(
    supabase,
    scanResult.scanId,
    businessName
  );

  // 9. Share link.
  const expiresAt = new Date(
    Date.now() + args.shareDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: link, error: linkErr } = await supabase
    .from('scan_share_links')
    .insert({
      scan_id: scanResult.scanId,
      expires_at: expiresAt,
      cta_text: args.shareCtaText,
      cta_url: args.shareCtaUrl,
    })
    .select('id')
    .single<{ id: string }>();
  if (linkErr || !link) {
    return {
      email: lead.email,
      businessName,
      status: 'failed',
      reason: `share link: ${linkErr?.message ?? 'no row'}`,
      costCents,
      matchedAddress: details.formattedAddress,
      matchedCategory: details.primaryType,
      keyword,
      turfScore: scanResult.turfScore,
      turfReach: scanResult.turfReach,
      turfRank: scanResult.turfRank,
      topCompetitor,
    };
  }

  return {
    email: lead.email,
    businessName,
    status: 'enriched',
    matchedAddress: details.formattedAddress,
    matchedCategory: details.primaryType,
    keyword,
    turfScore: scanResult.turfScore,
    turfReach: scanResult.turfReach,
    turfRank: scanResult.turfRank,
    topCompetitor,
    shareUrl: `${APP_ORIGIN}/share/${link.id}`,
    costCents,
  };
}

/**
 * Find the most-frequently-appearing competitor across the scan's
 * 81 grid cells. Excludes the client's own brand by first-word match.
 */
async function findTopCompetitor(
  supabase: ReturnType<typeof getServerSupabase>,
  scanId: string,
  businessName: string
): Promise<string | null> {
  const { data: points } = await supabase
    .from('scan_points')
    .select('competitors')
    .eq('scan_id', scanId);
  if (!points) return null;
  const ownPattern = new RegExp(
    businessName.split(/\s+/)[0] ?? '',
    'i'
  );
  const counts = new Map<string, number>();
  for (const p of points) {
    const list = (p.competitors ?? []) as Array<{ name?: string | null }>;
    for (const c of list) {
      if (!c?.name) continue;
      if (ownPattern.test(c.name)) continue;
      counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    }
  }
  let top: string | null = null;
  let topCount = 0;
  for (const [name, count] of counts) {
    if (count > topCount) {
      top = name;
      topCount = count;
    }
  }
  return top;
}

/**
 * Convert a Google Places primary_type ("hair_salon") into a search-
 * able keyword. Falls back to the first reasonable type in the types[]
 * list if primaryType is null. Returns null when nothing usable is
 * available — those rows are skipped (we don't want to fire scans on
 * "establishment" or "point_of_interest").
 */
function deriveKeyword(
  primaryType: string | null,
  types: string[]
): string | null {
  const NOISE = new Set([
    'establishment',
    'point_of_interest',
    'place_of_worship',
    'food',
    'health',
  ]);
  const fromPrimary = primaryType && !NOISE.has(primaryType) ? primaryType : null;
  const fromTypes = types.find((t) => !NOISE.has(t)) ?? null;
  const raw = fromPrimary ?? fromTypes;
  if (!raw) return null;
  return raw.replace(/_/g, ' ').toLowerCase().trim();
}

// ─── CSV I/O ─────────────────────────────────────────────────────────────

type Args = {
  input: string;
  fromPreview: string;
  output: string;
  limit: number | null;
  tags: string[] | null;
  skipTags: string[] | null;
  dryRun: boolean;
  shareDays: number | null;
  shareCtaText: string | null;
  shareCtaUrl: string | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | null => {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    return argv[idx + 1] ?? null;
  };
  return {
    input: get('--input') ?? '',
    fromPreview: get('--from-preview') ?? '',
    output: get('--output') ?? '',
    limit: get('--limit') ? Number(get('--limit')) : null,
    tags: get('--tag')?.split(',').map((s) => s.trim()) ?? null,
    skipTags: get('--skip-tag')?.split(',').map((s) => s.trim()) ?? null,
    dryRun: argv.includes('--dry-run'),
    shareDays: get('--share-days') ? Number(get('--share-days')) : null,
    shareCtaText: get('--share-cta-text'),
    shareCtaUrl: get('--share-cta-url'),
  };
}

/**
 * Tiny CSV reader scoped to the input shape. Avoids pulling in a
 * dependency for what is fundamentally a one-off campaign tool.
 * Handles quoted fields with embedded commas; doesn't handle
 * embedded quotes or multi-line cells (the input CSV has neither).
 */
function readLeads(filePath: string): Lead[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const ID_I = idx('Contact Id');
  const FIRST_I = idx('First Name');
  const LAST_I = idx('Last Name');
  const EMAIL_I = idx('Email');
  const NAME_I = idx('Business Name');
  const TAGS_I = idx('Tags');
  const out: Lead[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    out.push({
      contactId: row[ID_I] ?? '',
      firstName: row[FIRST_I] ?? '',
      lastName: row[LAST_I] ?? '',
      email: (row[EMAIL_I] ?? '').toLowerCase().trim(),
      businessName: (row[NAME_I] ?? '').trim(),
      tags: (row[TAGS_I] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function writeResults(filePath: string, results: EnrichmentResult[]) {
  const cols = [
    'email',
    'business_name',
    'status',
    'reason',
    'matched_address',
    'matched_category',
    'keyword',
    'turf_score',
    'turf_reach',
    'turf_rank',
    'top_competitor',
    'share_url',
  ];
  const csvEscape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const rows = results.map((r) =>
    [
      r.email,
      r.businessName,
      r.status,
      r.reason,
      r.matchedAddress,
      r.matchedCategory,
      r.keyword,
      r.turfScore,
      r.turfReach,
      r.turfRank,
      r.topCompetitor,
      r.shareUrl,
    ]
      .map(csvEscape)
      .join(',')
  );
  fs.writeFileSync(
    filePath,
    [cols.join(','), ...rows].join('\n') + '\n',
    'utf8'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
