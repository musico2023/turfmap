/**
 * One-off: generate Ryan / BVM Contracting's Visibility Audit
 * Roadmap PDF for Anthony's call tomorrow.
 *
 * Ryan is the first real VIP-cohort buyer (prospect_id=hVxWpmt1fD,
 * client_public_id=ced216b0fc). His free TurfScan returned a
 * TurfScore of 0 — completely invisible across all 81 cells of his
 * 9×9 grid for "Home Builder Toronto." That's the strongest pitch
 * surface possible: KingsGate Luxury Homes owns 98.8% of the top-3
 * across his entire grid; Ryan doesn't register anywhere.
 *
 * What this script does (no DB writes):
 *   1. Pulls his scan + scan_points from production Supabase
 *   2. Aggregates competitor data with synthesized TurfScores
 *      (heuristic from share_pct + avg_rank — used only for the
 *      sales deck's competitor list, never persisted)
 *   3. Calls generateRoadmap() against the production prompt → ~$0.20 Claude
 *   4. Renders RoadmapPdf via @react-pdf/renderer to a Buffer
 *   5. Saves to ~/Desktop/Ryan-BVM-Contracting-Visibility-Audit.pdf
 *
 * Run with:
 *   npx tsx scripts/generate-ryan-audit-pdf.ts
 *
 * Cost: ~$0.20 in Anthropic credits. No DataForSEO calls. No DB writes.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import React from 'react';

// Env loading: pull from the parent (non-worktree) repo's .env.local
// since worktrees don't get a copy. .env.local is the canonical
// dotfile after `vercel env pull --environment=production`.
//
// Order of precedence (highest wins):
//   1. Shell-injected vars (BRIGHTLOCAL_API_KEY=... npx tsx ...)
//   2. Values in .env.local file
//   3. (nothing else)
//
// Snapshot shell-injected values BEFORE dotenv runs, then restore
// any non-empty shell value AFTER. dotenv's `override:true` would
// otherwise stomp a shell value with an empty file value (which is
// exactly the case for BRIGHTLOCAL_API_KEY today — file has it
// empty, operator wants to pass it via shell prefix).
const shellSnapshot: Record<string, string> = {};
for (const k of Object.keys(process.env)) {
  const v = process.env[k];
  if (v != null && v.length > 0) shellSnapshot[k] = v;
}
const dotenvResult = loadEnv({
  path: '/Users/anthonyalfonsi/Claude/turfmap/.env.local',
  override: true,
});
// Restore shell wins for anything the shell had set non-empty.
for (const [k, v] of Object.entries(shellSnapshot)) {
  process.env[k] = v;
}
// One-line diagnostic: was the file parsed? How many keys did dotenv
// pull out? Did the Anthropic key make it in? Doesn't print the
// secret value — just presence + length.
const parsedKeys = dotenvResult.parsed
  ? Object.keys(dotenvResult.parsed)
  : [];
console.log(
  `[env-load] error=${!!dotenvResult.error} keys=${parsedKeys.length} has_anthropic=${parsedKeys.includes('ANTHROPIC_API_KEY')} sample=${parsedKeys.slice(0, 5).join(',')}`
);
if (dotenvResult.error) {
  console.error('[env-load] error detail:', dotenvResult.error);
}
console.log(
  `[env-load] resolved in process.env — ANTHROPIC=${(process.env.ANTHROPIC_API_KEY ?? '').length}b BRIGHTLOCAL=${(process.env.BRIGHTLOCAL_API_KEY ?? '').length}b SUPABASE_URL=${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').length}b`
);
// dotenv parsed the file (47 keys reported above) but didn't write
// BRIGHTLOCAL_API_KEY into process.env. Print the parsed-side value
// length to distinguish "value is empty in file" from "dotenv didn't
// promote it."
const parsedBl = dotenvResult.parsed?.BRIGHTLOCAL_API_KEY;
console.log(
  `[env-load] parsed BRIGHTLOCAL_API_KEY length in file: ${parsedBl == null ? 'absent' : String(parsedBl).length}`
);

import { getServerSupabase } from '../lib/supabase/server';
import {
  generateRoadmap,
  type RoadmapInput,
} from '../lib/ai/roadmapGenerator';
import { RoadmapPdf, type RoadmapPdfData } from '../components/pdf/RoadmapPdf';
import { renderToBuffer } from '@react-pdf/renderer';
import {
  initiateCitationAudit,
  pollAuditResults,
  summarizeFindings,
  type BusinessProfile,
} from '../lib/brightlocal/client';
import {
  getDirectoriesForIndustry,
  inferProfileForIndustry,
} from '../lib/brightlocal/directories';

// ─── Constants for Ryan ──────────────────────────────────────────────
const PROSPECT_ID = 'hVxWpmt1fD';
const SCAN_ID = 'a9899b30-37cd-4bad-a166-3089396afddd';
const CLIENT_ID = 'd8b74ccb-0bb2-4278-b0f9-93e54bec5320';
const BUSINESS_NAME = 'BVM Contracting';
const FIRST_NAME = 'Ryan';
const TRADE = 'General contractor (custom homes / renovations)';
const KEYWORD = 'Home Builder Toronto';
const MARKET = 'Scarborough / Toronto, ON';
const CURRENT_TURF_SCORE = 0;
// 10-point Lift Promise floor. With current=0 the projected target is
// a conservative 10 — the roadmap math may push this higher; we
// pin to whatever the 30-day cumulative lift surfaces.
const PROJECTED_FALLBACK = 10;

const OUTPUT_PATH = path.join(
  homedir(),
  'Desktop',
  'Ryan-BVM-Contracting-Visibility-Audit.pdf'
);

// Ryan's structured NAP (sourced from client_locations.id =
// 29137952-5094-454b-b563-e50c12ab4254 — his Toronto primary).
// Used only by the manual NAP audit override on this script; not
// otherwise persisted from here.
const RYAN_NAP: BusinessProfile = {
  name: BUSINESS_NAME,
  street_address: '80 Barbados Boulevard',
  city: 'Toronto',
  region: 'Ontario',
  postcode: 'M1J 0A2',
  country: 'CAN',
  telephone: '6474489603',
};

/**
 * One-off override: run a real NAP audit against BrightLocal for
 * Ryan. Normally gated off by autoAudit.ts for one_time billing_mode
 * clients (BL Data API trial preservation, commit 850a51b). Spending
 * ~3-10 trial credits here is explicitly authorized for the call
 * deck.
 */
async function runRyanNapAudit(): Promise<{
  findingsSummary: string;
  napFindingsForPdf: Array<{
    status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
    text: string;
  }>;
}> {
  // Ryan's prospects.trade is "General contractor" → home-services
  // directory profile via DEFAULT_FOR_UNMATCHED_INDUSTRY. CAN country
  // restricts the per-directory dispatch.
  const directories = getDirectoriesForIndustry(TRADE);
  const profile = inferProfileForIndustry(TRADE);
  console.log(
    `[nap-audit] profile=${profile} directories=${directories.length} (${directories.slice(0, 5).join(', ')}…)`
  );

  console.log('[nap-audit] initiating BL Data API fan-out…');
  const initResult = await initiateCitationAudit(RYAN_NAP, directories);
  console.log(
    `[nap-audit] queued requests=${initResult.requests.length} rejected=${initResult.rejected.length}`
  );
  if (initResult.rejected.length > 0) {
    console.log('[nap-audit] rejected directories:', initResult.rejected);
  }

  // Poll until ready. BL fan-out is usually 5-30s per directory.
  // 12s cadence matches the production cron (POLL_INTERVAL_MS in
  // autoAudit.ts) — that interval is calibrated against BL's 300
  // GET/min rate limit.
  const POLL_INTERVAL_MS = 12_000;
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;
  let summary;
  while (true) {
    summary = await pollAuditResults(initResult.requests);
    const readyCount = summary.perDirectory.filter((d) => d.ready).length;
    console.log(
      `[nap-audit] poll → ${readyCount}/${initResult.requests.length} ready${summary.allReady ? ' ✓' : ''}`
    );
    if (summary.allReady) break;
    if (Date.now() > deadline) {
      console.log(
        '[nap-audit] hit max wait — proceeding with partial results'
      );
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // No sibling locations for Ryan — single-location client.
  const findings = summarizeFindings(summary.perDirectory, RYAN_NAP, [], {
    industry: TRADE,
  });
  console.log(
    `[nap-audit] findings → citations=${findings.citations.length} inconsistencies=${findings.inconsistencies.length} missing=${findings.missing.length}`
  );

  // ─── Build the AI prompt's free-text summary ───────────────────────
  const lines: string[] = [];
  for (const c of findings.citations) {
    if (c.status === 'matched') {
      lines.push(`- ${c.directory}: live, NAP consistent`);
    } else if (c.status === 'mismatch') {
      lines.push(`- ${c.directory}: live, but NAP inconsistent`);
    } else if (c.status === 'unverified') {
      lines.push(`- ${c.directory}: live, NAP unverifiable`);
    }
  }
  for (const m of findings.missing) {
    lines.push(`- ${m.directory}: missing (priority: ${m.priority})`);
  }
  for (const i of findings.inconsistencies) {
    lines.push(
      `- ${i.directory}: ${i.field} differs (canonical "${i.canonical}" vs found "${i.found}")`
    );
  }
  const findingsSummary = lines.join('\n');

  // ─── Build the structured PDF rows ─────────────────────────────────
  // Cap at ~10 entries on the page so it doesn't overflow. Prioritize
  // inconsistencies (most actionable), then high-priority missing,
  // then live (proof of progress).
  const napFindingsForPdf: Array<{
    status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
    text: string;
  }> = [];
  for (const i of findings.inconsistencies.slice(0, 4)) {
    napFindingsForPdf.push({
      status: 'INCONSISTENT',
      text: `${i.directory} — ${i.field} differs from canonical`,
    });
  }
  const highPriorityMissing = findings.missing
    .filter((m) => m.priority === 'high')
    .slice(0, 6);
  const otherMissing = findings.missing
    .filter((m) => m.priority !== 'high')
    .slice(0, Math.max(0, 10 - napFindingsForPdf.length - highPriorityMissing.length));
  for (const m of [...highPriorityMissing, ...otherMissing]) {
    napFindingsForPdf.push({ status: 'MISSING', text: m.directory });
  }
  for (const c of findings.citations.filter((c) => c.status === 'matched').slice(0, 3)) {
    napFindingsForPdf.push({ status: 'LIVE', text: `${c.directory} — NAP consistent` });
  }

  return { findingsSummary, napFindingsForPdf };
}

// ─── Heuristic competitor TurfScore (deck-only) ──────────────────────
// We don't have real TurfScores for Ryan's competitors (we'd need to
// scan each one separately). Synthesize a defensible estimate from
// share_pct and avg_rank:
//   est = share_pct * (1 - (avg_rank - 1) / 6)
// KingsGate (98.8% / 1.6) → ~89
// Novacon (46.9% / 2.74) → ~33
// Xavieras (42.0% / 2.85) → ~29
// Used only for the competitor table on the PDF. Not stored anywhere.
function estimateCompetitorTurfScore(
  sharePct: number,
  avgRank: number
): number {
  const score = sharePct * (1 - (avgRank - 1) / 6);
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function main(): Promise<void> {
  const supabase = getServerSupabase();

  console.log(`[generate-ryan-audit-pdf] Pulling scan_points for ${SCAN_ID}…`);
  // Pull all 81 cells with normalized x/y (0-8). DENSE_RANK over
  // longitude/latitude maps DFS's exact-coord points to the grid
  // indices the PDF expects. y=0 is the northern row, y=8 the southern.
  const { data: pointsRaw, error: pointsErr } = await supabase
    .from('scan_points')
    .select('latitude, longitude, rank, business_found')
    .eq('scan_id', SCAN_ID);
  if (pointsErr || !pointsRaw) {
    throw new Error(
      `scan_points query failed: ${pointsErr?.message ?? 'no rows'}`
    );
  }
  console.log(`  → ${pointsRaw.length} points`);

  // JS-side equivalent of DENSE_RANK so we don't depend on Supabase
  // window functions in the JS client.
  const uniqLngs = Array.from(
    new Set(pointsRaw.map((p) => Number(p.longitude)))
  ).sort((a, b) => a - b);
  const uniqLatsDesc = Array.from(
    new Set(pointsRaw.map((p) => Number(p.latitude)))
  ).sort((a, b) => b - a);
  const cells = pointsRaw.map((p) => ({
    x: uniqLngs.indexOf(Number(p.longitude)),
    y: uniqLatsDesc.indexOf(Number(p.latitude)),
    rank: p.business_found ? (p.rank as number | null) : null,
  }));

  // ─── Competitor aggregation across all 81 cells ───────────────────
  console.log('[generate-ryan-audit-pdf] Aggregating competitors…');
  type RawCompetitor = {
    name: string;
    rank_absolute: number;
    domain?: string;
  };
  const competitorTallies = new Map<
    string,
    { name: string; appearances: number; rankSum: number }
  >();
  for (const p of pointsRaw) {
    // competitors is stored on scan_points but we didn't select it
    // — re-fetch per-point would be slow. Use a single SQL trip.
  }
  // One trip for the competitor breakdown — cheaper than the per-row
  // tally above.
  const { data: compRows, error: compErr } = await supabase
    .from('scan_points')
    .select('competitors')
    .eq('scan_id', SCAN_ID);
  if (compErr || !compRows) {
    throw new Error(
      `competitor query failed: ${compErr?.message ?? 'no rows'}`
    );
  }
  for (const row of compRows) {
    const arr = (row.competitors ?? []) as RawCompetitor[];
    for (const c of arr) {
      if (!c.name) continue;
      // Filter the "My Ad Center" sponsored marker that DFS sometimes
      // returns at rank_absolute=1.
      if (c.name.includes('My Ad Center')) continue;
      if (c.domain === 'google.com') continue;
      const key = c.name;
      const t =
        competitorTallies.get(key) ?? { name: c.name, appearances: 0, rankSum: 0 };
      t.appearances += 1;
      t.rankSum += c.rank_absolute;
      competitorTallies.set(key, t);
    }
  }
  const competitorsRanked = Array.from(competitorTallies.values())
    .map((t) => {
      const sharePct = (t.appearances / 81) * 100;
      const avgRank = t.rankSum / t.appearances;
      return {
        name: t.name,
        sharePct,
        avgRank,
        turfScore: estimateCompetitorTurfScore(sharePct, avgRank),
      };
    })
    .sort((a, b) => b.sharePct - a.sharePct);
  const top3 = competitorsRanked.slice(0, 3);
  console.log(
    '  → top 3:',
    top3.map((c) => `${c.name} (${c.sharePct.toFixed(1)}% / rank ${c.avgRank.toFixed(2)} / est. TS ${c.turfScore})`)
  );

  // ─── AI prompt inputs ─────────────────────────────────────────────
  const competitorSummary = top3
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}: TurfScore ~${c.turfScore} (est.), holds ${c.sharePct.toFixed(1)}% of top-3 across Ryan's 9×9 grid (avg rank ${c.avgRank.toFixed(2)})`
    )
    .join('\n');
  const cellPatternSummary =
    'Ryan is invisible across ALL 81 cells (0% TurfReach). The 9×9 grid covers his Scarborough HQ + ~5 mi north and west. KingsGate Luxury Homes appears in the top-3 for 98.8% of the same cells, with an average rank of 1.6 — owns the keyword in Ryan\'s own backyard. Novacon (46.9% share), Xavieras (42.0%), Vicolo (37.0%) form the supporting cast. No mid-tier competitors visible — the top is dominated by 4-5 brands with large directory/review footprints.';

  // Manual NAP audit override (authorized by operator for the call
  // deck). Burns ~3-10 BL Data API trial credits.
  const { findingsSummary: napFindingsSummary, napFindingsForPdf } =
    await runRyanNapAudit();

  const roadmapInput: RoadmapInput = {
    businessName: BUSINESS_NAME,
    trade: TRADE,
    keyword: KEYWORD,
    market: MARKET,
    currentTurfScore: CURRENT_TURF_SCORE,
    turfReach: 0,
    turfRank: null, // no pack appearances → no avg rank to report
    napFindingsSummary,
    competitorSummary,
    cellPatternSummary,
  };

  // ─── Generate roadmap ─────────────────────────────────────────────
  console.log(
    `[generate-ryan-audit-pdf] env check — ANTHROPIC=${(process.env.ANTHROPIC_API_KEY ?? '').length}b BRIGHTLOCAL=${(process.env.BRIGHTLOCAL_API_KEY ?? '').length}b SUPABASE_URL=${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').length}b`
  );
  console.log('[generate-ryan-audit-pdf] Calling generateRoadmap()…');
  const roadmap = await generateRoadmap(roadmapInput);
  console.log(`  → ${roadmap.actions.length} actions, 30d lift ${roadmap.thirtyDayTargetLift}, 90d lift ${roadmap.ninetyDayTargetLift}`);
  console.log(`  → diagnosis: ${roadmap.diagnosis}`);

  // The Lift Promise wants projected = current + max(thirtyDayTargetLift, 10).
  // For Ryan we floor at +10 since current=0.
  const projectedTurfScore =
    CURRENT_TURF_SCORE +
    Math.max(roadmap.thirtyDayTargetLift, PROJECTED_FALLBACK);

  // ─── Build PDF data ───────────────────────────────────────────────
  const pdfData: RoadmapPdfData = {
    businessName: BUSINESS_NAME,
    trade: TRADE,
    market: MARKET,
    auditDate: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    currentTurfScore: CURRENT_TURF_SCORE,
    projectedTurfScore,
    diagnosis: roadmap.diagnosis,
    actions: roadmap.actions.map((a) => ({
      week: a.week,
      action: a.action,
      category: a.category,
      pillar: a.pillar,
      difficulty: a.difficulty,
      priority: a.priority,
      projectedScoreLift: a.projectedScoreLift,
      llmCovered: a.llmCovered,
    })),
    napFindings: napFindingsForPdf,
    competitors: top3.map((c) => ({
      name: c.name,
      turfScore: c.turfScore,
      differential: `Holds top-3 in ${c.sharePct.toFixed(1)}% of Ryan's grid (avg rank ${c.avgRank.toFixed(2)})`,
    })),
    cells,
    ninetyDayTargetLift: roadmap.ninetyDayTargetLift,
  };

  // ─── Render PDF ───────────────────────────────────────────────────
  console.log('[generate-ryan-audit-pdf] Rendering PDF…');
  const buf = await renderToBuffer(
    React.createElement(RoadmapPdf, { data: pdfData })
  );
  console.log(`  → ${buf.length} bytes`);

  await writeFile(OUTPUT_PATH, buf);
  console.log(`\n✓ PDF saved to: ${OUTPUT_PATH}`);
  console.log(`  open it with: open "${OUTPUT_PATH}"`);
}

main().catch((e) => {
  console.error('[generate-ryan-audit-pdf] FAILED:', e);
  process.exit(1);
});
