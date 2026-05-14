/**
 * Phase 1 of the outreach-lead campaign — *preview only*, no scans.
 *
 * Reads the past-leads CSV, does a Google Places lookup per row, and
 * emits a review CSV showing what each lead matched to + the keyword
 * we'd scan with. Operator reviews/corrects in a spreadsheet, then
 * feeds it into `npm run enrich:leads -- --from-preview <reviewed>`
 * for Phase 2 (the actual DFS scans + share-link generation).
 *
 * Why split: DFS Live scans cost ~$0.16 each. We don't want to pay
 * that on bad keyword matches or wrong businesses — the previous
 * single-pass version produced TurfScore 0 enrichments because the
 * auto-derived keyword was meaningless for some categories. This
 * lets the operator catch those before any DFS budget is spent.
 *
 * Run with:
 *   npm run preview:leads -- \
 *     --input  /path/to/Export_Contacts_All_…csv \
 *     --output ./outreach-preview.csv \
 *     --tag    llm,llm-form-submit,diner,roofing \
 *     --skip-tag signed,dfy-onboarding,dfy-onboarding-call-booked
 *
 * Cost: ~$0.025 per lead (Places search + details). 110 leads ≈ $2.75.
 *
 * Output CSV (one row per input lead):
 *   email, business_name, lead_tags,
 *   match_status,        (matched | no_match | error)
 *   place_id, matched_name, matched_address, matched_category,
 *   matched_lat, matched_lng,
 *   derived_keyword, confidence,
 *   keyword_override,    (operator fills in to override the keyword)
 *   skip,                (operator fills 'y' to exclude this lead)
 *   notes                (free-form for operator notes)
 *
 * Confidence flags:
 *   high   — name match ≥ 0.5 jaccard AND primary_type is non-generic
 *   review — needs operator eyeballing (low name match, generic type,
 *            or fallback type from types[] array)
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { searchPlaces, getPlaceDetails } from '../lib/google/places';

type Lead = {
  email: string;
  businessName: string;
  tags: string[];
};

type PreviewRow = {
  email: string;
  businessName: string;
  leadTags: string;
  matchStatus: 'matched' | 'no_match' | 'error';
  placeId: string | null;
  matchedName: string | null;
  matchedAddress: string | null;
  matchedCategory: string | null;
  matchedLat: number | null;
  matchedLng: number | null;
  derivedKeyword: string | null;
  confidence: 'high' | 'review' | '';
  keywordOverride: string;
  skip: string;
  notes: string;
};

const GENERIC_TYPES = new Set([
  'establishment',
  'point_of_interest',
  'place_of_worship',
  'food',
  'health',
  'general_contractor',
  'professional_services',
  'finance',
  'corporate_office',
]);

async function main() {
  const args = parseArgs();
  if (!args.input || !args.output) {
    console.error(
      'Usage: npm run preview:leads -- --input <csv> --output <csv> [--limit N] [--tag a,b] [--skip-tag c,d] [--dry-run]'
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
    `[preview-leads] read=${leads.length} after-filter=${filtered.length} processing=${work.length}${args.dryRun ? ' (dry-run)' : ''}`
  );

  if (args.dryRun) {
    for (const l of work.slice(0, 20)) {
      console.log(`  - ${l.email} / ${l.businessName} [${l.tags.join(', ')}]`);
    }
    if (work.length > 20) console.log(`  …and ${work.length - 20} more`);
    console.log(
      `\nEstimated cost if run for real: ~$${(work.length * 0.025).toFixed(2)}`
    );
    return;
  }

  const rows: PreviewRow[] = [];
  for (let i = 0; i < work.length; i++) {
    const lead = work[i];
    process.stdout.write(`[${i + 1}/${work.length}] ${lead.businessName}… `);
    const row = await previewOne(lead);
    rows.push(row);
    if (row.matchStatus === 'matched') {
      console.log(
        `${row.confidence === 'high' ? '✓' : '?'} "${row.matchedName}" → keyword "${row.derivedKeyword}" (${row.confidence})`
      );
    } else {
      console.log(`– ${row.matchStatus}`);
    }
  }

  writeRows(args.output, rows);

  const matched = rows.filter((r) => r.matchStatus === 'matched');
  const high = matched.filter((r) => r.confidence === 'high').length;
  const review = matched.filter((r) => r.confidence === 'review').length;
  const noMatch = rows.filter((r) => r.matchStatus === 'no_match').length;

  console.log(
    `\n[preview-leads] done. matched=${matched.length} (high=${high}, review=${review}) no_match=${noMatch}`
  );
  console.log(`Output: ${args.output}`);
  console.log(
    `\nNext: open the CSV, fix any 'review' rows (override keyword, mark skip='y'), then:`
  );
  console.log(
    `  npm run enrich:leads -- --from-preview ${args.output} --output <enriched.csv>`
  );
}

async function previewOne(lead: Lead): Promise<PreviewRow> {
  const base: PreviewRow = {
    email: lead.email,
    businessName: lead.businessName,
    leadTags: lead.tags.join('|'),
    matchStatus: 'no_match',
    placeId: null,
    matchedName: null,
    matchedAddress: null,
    matchedCategory: null,
    matchedLat: null,
    matchedLng: null,
    derivedKeyword: null,
    confidence: '',
    keywordOverride: '',
    skip: '',
    notes: '',
  };

  // Two-pass search: first with country bias (most leads are CAN),
  // then with US bias as a fallback. Take up to 5 candidates per pass
  // and pick the one whose displayName best matches the lead's
  // business_name by Jaccard similarity — relevance ranking alone
  // is unreliable for small local businesses.
  let candidate;
  try {
    candidate = await bestCandidateForName(lead.businessName);
  } catch (e) {
    base.matchStatus = 'error';
    base.notes = e instanceof Error ? e.message : String(e);
    return base;
  }
  if (!candidate) return base;

  let details;
  try {
    details = await getPlaceDetails(candidate.placeId);
  } catch (e) {
    base.matchStatus = 'error';
    base.notes = e instanceof Error ? e.message : String(e);
    return base;
  }
  if (!details) return base;

  base.matchStatus = 'matched';
  base.placeId = details.placeId;
  base.matchedName = details.displayName;
  base.matchedAddress = details.formattedAddress;
  base.matchedCategory = details.primaryType;
  base.matchedLat = details.latitude;
  base.matchedLng = details.longitude;
  base.derivedKeyword = deriveKeyword(details.primaryType, details.types);
  base.confidence = computeConfidence({
    submittedName: lead.businessName,
    matchedName: details.displayName,
    primaryType: details.primaryType,
    derivedKeyword: base.derivedKeyword,
  });
  return base;
}

/**
 * Find the best Places candidate for a business name. Tries CA-biased
 * search first; falls back to US bias if nothing reasonable comes
 * back. "Best" = Jaccard similarity ≥ 0.3 between submitted name and
 * matched displayName, with the highest-scoring candidate winning.
 * Returns null when no candidate clears the threshold.
 */
async function bestCandidateForName(businessName: string) {
  const passes: Array<{ regionCode: string }> = [
    { regionCode: 'CA' },
    { regionCode: 'US' },
  ];
  let best: { sim: number; cand: Awaited<ReturnType<typeof searchPlaces>>['candidates'][number] } | null = null;
  for (const pass of passes) {
    const search = await searchPlaces({
      query: businessName,
      latitude: null,
      longitude: null,
      maxResults: 5,
      regionCode: pass.regionCode,
    });
    for (const cand of search.candidates) {
      const sim = jaccard(businessName, cand.displayName ?? '');
      if (sim >= 0.3 && (!best || sim > best.sim)) {
        best = { sim, cand };
      }
    }
    // Once we have a strong match in CA, don't bother with the US pass.
    if (best && best.sim >= 0.6) break;
  }
  return best?.cand ?? null;
}

function deriveKeyword(
  primaryType: string | null,
  types: string[]
): string | null {
  const fromPrimary =
    primaryType && !GENERIC_TYPES.has(primaryType) ? primaryType : null;
  const fromTypes = types.find((t) => !GENERIC_TYPES.has(t)) ?? null;
  const raw = fromPrimary ?? fromTypes;
  if (!raw) return null;
  return raw.replace(/_/g, ' ').toLowerCase().trim();
}

function computeConfidence(args: {
  submittedName: string;
  matchedName: string | null;
  primaryType: string | null;
  derivedKeyword: string | null;
}): 'high' | 'review' {
  if (!args.derivedKeyword) return 'review';
  if (!args.matchedName) return 'review';
  // Generic primary_type → reviewer should sanity-check the keyword
  // even if the name match is good (e.g. an "establishment"-typed
  // listing might be a small business but the right keyword is
  // industry-specific, not "establishment").
  if (!args.primaryType || GENERIC_TYPES.has(args.primaryType)) return 'review';
  // Name token similarity check — if Google matched something
  // tangentially, the operator should look.
  const sim = jaccard(args.submittedName, args.matchedName);
  if (sim < 0.5) return 'review';
  return 'high';
}

const NAME_NOISE = new Set([
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'co',
  'company',
  'group',
  'the',
  'and',
  '&',
]);

function jaccard(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t && !NAME_NOISE.has(t))
    );
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ─── CSV I/O ─────────────────────────────────────────────────────────────

type Args = {
  input: string;
  output: string;
  limit: number | null;
  tags: string[] | null;
  skipTags: string[] | null;
  dryRun: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | null => {
    const idx = argv.indexOf(name);
    return idx === -1 ? null : argv[idx + 1] ?? null;
  };
  return {
    input: get('--input') ?? '',
    output: get('--output') ?? '',
    limit: get('--limit') ? Number(get('--limit')) : null,
    tags: get('--tag')?.split(',').map((s) => s.trim()) ?? null,
    skipTags: get('--skip-tag')?.split(',').map((s) => s.trim()) ?? null,
    dryRun: argv.includes('--dry-run'),
  };
}

function readLeads(filePath: string): Lead[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const EMAIL_I = idx('Email');
  const NAME_I = idx('Business Name');
  const TAGS_I = idx('Tags');
  const out: Lead[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    out.push({
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

const PREVIEW_COLS: Array<keyof PreviewRow> = [
  'email',
  'businessName',
  'leadTags',
  'matchStatus',
  'placeId',
  'matchedName',
  'matchedAddress',
  'matchedCategory',
  'matchedLat',
  'matchedLng',
  'derivedKeyword',
  'confidence',
  'keywordOverride',
  'skip',
  'notes',
];

const PREVIEW_HEADER: Record<keyof PreviewRow, string> = {
  email: 'email',
  businessName: 'business_name',
  leadTags: 'lead_tags',
  matchStatus: 'match_status',
  placeId: 'place_id',
  matchedName: 'matched_name',
  matchedAddress: 'matched_address',
  matchedCategory: 'matched_category',
  matchedLat: 'matched_lat',
  matchedLng: 'matched_lng',
  derivedKeyword: 'derived_keyword',
  confidence: 'confidence',
  keywordOverride: 'keyword_override',
  skip: 'skip',
  notes: 'notes',
};

function writeRows(filePath: string, rows: PreviewRow[]) {
  const csvEscape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = PREVIEW_COLS.map((c) => PREVIEW_HEADER[c]).join(',');
  const body = rows
    .map((r) => PREVIEW_COLS.map((c) => csvEscape(r[c])).join(','))
    .join('\n');
  fs.writeFileSync(filePath, header + '\n' + body + '\n', 'utf8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
