/**
 * Personalize the enriched outreach CSV with sequenced email copy.
 *
 * Reads:
 *   - The enriched-leads CSV (output of enrich-leads --from-preview)
 *   - The original lead CSV (for first names — enrichment loses them)
 *
 * Writes a final CSV with two-sequence email content per row:
 *   sequence_a_subject + sequence_a_body  — tease the heatmap, no link
 *   sequence_b_subject + sequence_b_body  — share URL + 50% off CTA
 *
 * Tier-specific framing:
 *   A (TurfScore 40+)   — "You're dominating but [comp] is hunting" (defend)
 *   B (15-39)           — "You're patchy — here's why" (fix)
 *   C (1-14)            — "[Comp] owns territory you should" (expose)
 *
 * HighLevel ingest: each contact's `sequence_a_body` field merges
 * into a single email template body (`{{contact.sequence_a_body}}`).
 * Each lead gets fully-rendered prose specific to their score +
 * competitor + keyword + city. Anthony reviews/tweaks before sending.
 *
 * Run:
 *   npm run personalize:outreach -- \
 *     --enriched ./outreach-enriched-llm.csv \
 *     --leads /path/to/Export_Contacts_All.csv \
 *     --output ./outreach-final.csv
 *
 * Skips rows in 'score_0' / 'failed' / 'no_link' tiers — operator can
 * still pull them in manually if desired.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

type EnrichedRow = {
  email: string;
  business_name: string;
  status: string;
  matched_address: string;
  matched_category: string;
  keyword: string;
  turf_score: string;
  turf_reach: string;
  turf_rank: string;
  top_competitor: string;
  share_url: string;
};

type LeadRow = {
  email: string;
  first_name: string;
  business_name: string;
};

type Tier = 'A' | 'B' | 'C' | 'skip';

const APP_HOST = 'https://turfmap.ai';
const COUPON_NOTE = '50% off your first TurfScan ($49 — code at checkout)';

function tierFor(score: number, hasShareUrl: boolean): Tier {
  if (!hasShareUrl) return 'skip';
  if (score >= 40) return 'A';
  if (score >= 15) return 'B';
  if (score >= 1) return 'C';
  return 'skip';
}

function extractCity(address: string): string {
  // Address looks like "123 Foo St, Toronto, ON M5V 2T9, Canada"
  // Pick the second-to-last comma-delimited segment that has alphabet chars.
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return parts[parts.length - 3] || '';
  }
  return parts[0] || '';
}

function firstNameOrFallback(firstName: string): string {
  const trimmed = firstName.trim();
  if (!trimmed) return 'there';
  // Capitalize first letter; preserve rest.
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function sigBlock(): string {
  return `\n\n— Anthony\nFourdots Digital | TurfMap.ai`;
}

// ─── Tier A: dominant, defend it ─────────────────────────────────────────

function tierA_subjectA(business: string, comp: string): string {
  return `${business}'s territory map — you're winning, but ${truncCompetitor(comp)} is the one to watch`;
}

function tierA_bodyA(opts: {
  firstName: string;
  business: string;
  score: number;
  reach: number;
  keyword: string;
  city: string;
  competitor: string;
}): string {
  const compLine = opts.competitor
    ? `Your closest challenger is ${opts.competitor} — they're picking up the cells where you're not #1.`
    : `Most cells in your service area, ${opts.business} is the only one in the 3-pack.`;
  return `Hey ${opts.firstName},

I built a tool that maps where local businesses appear in Google's 3-pack across their service area, cell-by-cell. Curiosity got the better of me — I ran one for ${opts.business}.

For "${opts.keyword}" in ${opts.city}, your TurfScore came back at ${opts.score} / 100. ${tierABand(opts.score)} ${compLine}

I have the full heatmap built — 9×9 grid showing exactly which cells you own and which ones are contested. Want me to send it over? Reply "yes" and I'll fire it back today.${sigBlock()}`;
}

function tierA_subjectB(business: string, score: number): string {
  return `${business} — your TurfMap (TurfScore ${score})`;
}

function tierA_bodyB(opts: {
  firstName: string;
  business: string;
  score: number;
  competitor: string;
  shareUrl: string;
  keyword: string;
}): string {
  return `Hey ${opts.firstName},

Here it is — your live TurfMap:

${opts.shareUrl}

You're sitting at ${opts.score} / 100 for "${opts.keyword}." The grid shows the cells you dominate, where ${opts.competitor || 'competitors'} ${opts.competitor ? 'is winning' : 'are picking up share'}, and the contested zones in between.

The map is the snapshot. The real value is what TurfMap does next — its AI Coach reads your grid + competitor pattern + GBP signals and generates a tailored action plan to defend the cells you own and convert the contested ones.

If you want that action plan, I'm offering ${COUPON_NOTE} for the next 7 days. The plan ships within 24 hours of the scan completing.

${APP_HOST}?utm_source=outreach&utm_medium=email&utm_campaign=llm_a${sigBlock()}`;
}

// ─── Tier B: patchy, real fix ────────────────────────────────────────────

function tierB_subjectA(business: string, score: number): string {
  return `Why ${business} is patchy in the local pack (TurfScore ${score})`;
}

function tierB_bodyA(opts: {
  firstName: string;
  business: string;
  score: number;
  reach: number;
  keyword: string;
  city: string;
  competitor: string;
}): string {
  const compLine = opts.competitor
    ? `${opts.competitor} is dominating the cells where you're missing — eating territory you should own.`
    : `You're showing up inconsistently across your service area.`;
  return `Hey ${opts.firstName},

I run a tool that maps where local businesses appear in Google's 3-pack, cell-by-cell. Ran one on ${opts.business} this week.

For "${opts.keyword}" across ${opts.city}, your TurfScore is ${opts.score} / 100 — that's the "Patchy" band. You appear in the pack in some neighborhoods but go invisible in others. ${compLine}

The pattern usually traces to one of three things: GBP categories, NAP consistency across directories, or review velocity that's geographically lopsided. The heatmap shows exactly where the gaps are.

Want me to send it over? Reply "yes" and you'll have it today.${sigBlock()}`;
}

function tierB_subjectB(business: string): string {
  return `${business} — your TurfMap is up`;
}

function tierB_bodyB(opts: {
  firstName: string;
  business: string;
  score: number;
  competitor: string;
  shareUrl: string;
  keyword: string;
}): string {
  return `Hey ${opts.firstName},

Your TurfMap is live: ${opts.shareUrl}

The grid shows where ${opts.business} appears for "${opts.keyword}" — the green cells are wins, the gray cells are where ${opts.competitor || 'competitors'} ${opts.competitor ? 'has the pack' : 'are taking the pack'}.

A 9×9 patchy grid like yours has a fixable shape — the AI Coach inside TurfMap reads the pattern + your GBP signals and generates a step-by-step action plan to lift the score. Most "Patchy" bands move 15-25 points in 60 days when the operator works the plan.

${COUPON_NOTE} if you want the action plan — running for 7 days only.

${APP_HOST}?utm_source=outreach&utm_medium=email&utm_campaign=llm_b${sigBlock()}`;
}

// ─── Tier C: invisible, expose-and-fix ───────────────────────────────────

function tierC_subjectA(competitor: string, business: string): string {
  if (competitor) {
    return `${truncCompetitor(competitor)} is taking your territory — TurfMap on ${business}`;
  }
  return `${business} is invisible across your service area`;
}

function tierC_bodyA(opts: {
  firstName: string;
  business: string;
  score: number;
  keyword: string;
  city: string;
  competitor: string;
}): string {
  const compLine = opts.competitor
    ? `${opts.competitor} is in the top 3 across the cells you're missing — they're systematically taking territory you should own.`
    : `Other operators are filling the pack for "${opts.keyword}" across your area.`;
  return `Hey ${opts.firstName},

I run a tool that maps where businesses show up in Google's 3-pack across their service area. I ran it on ${opts.business} for "${opts.keyword}" in ${opts.city}.

The result was rough: TurfScore ${opts.score} / 100. You're barely registering in the local pack. ${compLine}

That's a brutal map — but it's also the easiest kind of map to fix. Most invisible-band businesses have a single fixable issue: GBP categories miscoded, NAP inconsistency across directories, or reviews that haven't kept pace.

I have the full heatmap and a quick diagnosis. Reply "yes" and I'll send it over.${sigBlock()}`;
}

function tierC_subjectB(business: string): string {
  return `${business} — here's why you're invisible (and the fix)`;
}

function tierC_bodyB(opts: {
  firstName: string;
  business: string;
  competitor: string;
  shareUrl: string;
  keyword: string;
}): string {
  const compLine = opts.competitor
    ? `${opts.competitor} owns the territory while you're sitting outside the pack.`
    : `Other operators have the pack while you're not appearing.`;
  return `Hey ${opts.firstName},

Here's the TurfMap for ${opts.business}: ${opts.shareUrl}

It's the visual version of what was probably already a hunch — almost no green cells across the grid for "${opts.keyword}." ${compLine}

The good news: this is the most fixable map shape there is. The AI Coach inside TurfMap reads your grid + GBP signals + NAP audit and generates an action plan that gets specific — which directories to fix, which categories to add, which review-cadence target to hit.

${COUPON_NOTE} if you want that plan — 7 days only.

${APP_HOST}?utm_source=outreach&utm_medium=email&utm_campaign=llm_c${sigBlock()}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function tierABand(score: number): string {
  if (score >= 90) return `That's the top tier — most local-services operators sit between 30 and 50.`;
  if (score >= 70) return `That's a strong band — the top quartile of operators we scan.`;
  if (score >= 40) return `That's the "Established" band — solid territory.`;
  return '';
}

function truncCompetitor(comp: string): string {
  // Long competitor names look bad in subject lines — first 4-5 words.
  if (!comp) return '';
  const words = comp.split(/\s+/);
  if (words.length <= 5) return comp;
  return words.slice(0, 5).join(' ') + '…';
}

// ─── CSV I/O ─────────────────────────────────────────────────────────────

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === ',' && !q) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function readEnriched(filePath: string): EnrichedRow[] {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = parseLine(lines[0]);
  const idx = (n: string) => header.indexOf(n);
  const I = {
    email: idx('email'),
    bn: idx('business_name'),
    status: idx('status'),
    addr: idx('matched_address'),
    cat: idx('matched_category'),
    kw: idx('keyword'),
    score: idx('turf_score'),
    reach: idx('turf_reach'),
    rank: idx('turf_rank'),
    top: idx('top_competitor'),
    url: idx('share_url'),
  };
  return lines.slice(1).map((l) => {
    const r = parseLine(l);
    return {
      email: (r[I.email] ?? '').toLowerCase(),
      business_name: r[I.bn] ?? '',
      status: r[I.status] ?? '',
      matched_address: r[I.addr] ?? '',
      matched_category: r[I.cat] ?? '',
      keyword: r[I.kw] ?? '',
      turf_score: r[I.score] ?? '',
      turf_reach: r[I.reach] ?? '',
      turf_rank: r[I.rank] ?? '',
      top_competitor: r[I.top] ?? '',
      share_url: r[I.url] ?? '',
    };
  });
}

function readLeads(filePath: string): Map<string, LeadRow> {
  const map = new Map<string, LeadRow>();
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return map;
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const EMAIL_I = idx('email');
  const FIRST_I = idx('first name');
  const NAME_I = idx('business name');
  for (let i = 1; i < lines.length; i++) {
    const r = parseLine(lines[i]);
    const email = (r[EMAIL_I] ?? '').toLowerCase().trim();
    if (!email) continue;
    map.set(email, {
      email,
      first_name: (r[FIRST_I] ?? '').trim(),
      business_name: (r[NAME_I] ?? '').trim(),
    });
  }
  return map;
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const get = (n: string): string | null => {
    const i = argv.indexOf(n);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const enrichedPath = get('--enriched');
  const leadsPath = get('--leads');
  const outputPath = get('--output');
  if (!enrichedPath || !leadsPath || !outputPath) {
    console.error(
      'Usage: npm run personalize:outreach -- --enriched <enriched.csv> --leads <leads.csv> --output <out.csv>'
    );
    process.exit(1);
  }

  const enriched = readEnriched(enrichedPath);
  const leadsByEmail = readLeads(leadsPath);

  type FinalRow = EnrichedRow & {
    tier: Tier;
    first_name: string;
    sequence_a_subject: string;
    sequence_a_body: string;
    sequence_b_subject: string;
    sequence_b_body: string;
  };

  const final: FinalRow[] = enriched.map((r) => {
    const score = Number(r.turf_score) || 0;
    const reach = Number(r.turf_reach) || 0;
    const tier = tierFor(score, !!r.share_url);
    const lead = leadsByEmail.get(r.email);
    const firstName = firstNameOrFallback(lead?.first_name ?? '');
    const city = extractCity(r.matched_address);
    const ctx = {
      firstName,
      business: r.business_name,
      score,
      reach,
      keyword: r.keyword,
      city,
      competitor: r.top_competitor,
      shareUrl: r.share_url,
    };

    let saSub = '';
    let saBody = '';
    let sbSub = '';
    let sbBody = '';
    if (tier === 'A') {
      saSub = tierA_subjectA(r.business_name, r.top_competitor);
      saBody = tierA_bodyA(ctx);
      sbSub = tierA_subjectB(r.business_name, score);
      sbBody = tierA_bodyB(ctx);
    } else if (tier === 'B') {
      saSub = tierB_subjectA(r.business_name, score);
      saBody = tierB_bodyA(ctx);
      sbSub = tierB_subjectB(r.business_name);
      sbBody = tierB_bodyB(ctx);
    } else if (tier === 'C') {
      saSub = tierC_subjectA(r.top_competitor, r.business_name);
      saBody = tierC_bodyA(ctx);
      sbSub = tierC_subjectB(r.business_name);
      sbBody = tierC_bodyB(ctx);
    }

    return {
      ...r,
      tier,
      first_name: lead?.first_name ?? '',
      sequence_a_subject: saSub,
      sequence_a_body: saBody,
      sequence_b_subject: sbSub,
      sequence_b_body: sbBody,
    };
  });

  // Write CSV — keep enrichment cols, append the new ones.
  const cols: Array<keyof FinalRow> = [
    'tier',
    'first_name',
    'email',
    'business_name',
    'matched_address',
    'matched_category',
    'keyword',
    'turf_score',
    'turf_reach',
    'turf_rank',
    'top_competitor',
    'share_url',
    'sequence_a_subject',
    'sequence_a_body',
    'sequence_b_subject',
    'sequence_b_body',
    'status',
  ];
  const header = cols.join(',');
  const body = final
    .map((r) => cols.map((c) => csvEscape(r[c])).join(','))
    .join('\n');
  fs.writeFileSync(outputPath, header + '\n' + body + '\n', 'utf8');

  // Console summary.
  const counts: Record<Tier, number> = { A: 0, B: 0, C: 0, skip: 0 };
  for (const r of final) counts[r.tier] += 1;
  console.log(
    `[personalize] wrote=${final.length}  A=${counts.A}  B=${counts.B}  C=${counts.C}  skipped=${counts.skip}`
  );
  console.log(`Output: ${outputPath}`);
}

main();
