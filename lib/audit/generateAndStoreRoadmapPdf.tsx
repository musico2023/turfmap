/**
 * Generate + store the buyer's 90-Day Visibility Roadmap PDF for a
 * given visibility_audits row.
 *
 * Fires from two call sites today:
 *
 *   1. /api/orders/fulfill — at audit-tier purchase, immediately
 *      after the visibility_audits row is created. The buyer gets
 *      the PDF emailed within ~60s of paying, instead of waiting
 *      for a strategist call (or never, on the legacy path). This
 *      is the "automatic for every audit buyer" path Anthony asked
 *      for as a mirror of the manual one-off `generate-ryan-audit-pdf`
 *      script that was previously the only way to ship a Roadmap PDF
 *      to a non-paying VIP buyer.
 *
 *   2. /api/cron/audit-milestones — at T-24h before the buyer's
 *      strategist call, REGENERATES the PDF for freshness (NAP audit
 *      may have completed asynchronously, Apollo enrichment may have
 *      landed, etc.) before emailing Anthony's prep packet. Overwrites
 *      the at-purchase version stamped on the audit row.
 *
 * Template: components/pdf/RoadmapPdf.tsx — pillar-based (visibility,
 * demand, systems) action plan, 12 weeks across 3 phases. The pillar
 * framework is the same one Local Lead Machine sells under and is
 * baked into actionCategories.ts.
 *
 * Cost: ~$0.20 in Anthropic credits per call (Claude Sonnet 4.6 with
 * prompt caching). At-purchase generation + T-24h regeneration =
 * ~$0.40 per audit buyer who books a call. Buyers who never book
 * still get one generation (at purchase). Acceptable on a $499 ticket.
 *
 * Returns the PDF buffer so the calling site can attach it to an
 * email without re-reading from Storage. The audit row's
 * roadmap_pdf_url + lift_promise_target_score are stamped on success.
 */

import { renderToBuffer } from '@react-pdf/renderer';
import {
  generateRoadmap,
  type RoadmapKeywordStats,
} from '@/lib/ai/roadmapGenerator';
import { patchVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { uploadRoadmapPdf, signedUrlForAuditFile } from '@/lib/audit/storage';
import {
  RoadmapPdf,
  type RoadmapPdfData,
  type RoadmapPdfCompetitor,
  type RoadmapPdfKeywordRow,
  type RoadmapPdfNapFinding,
} from '@/components/pdf/RoadmapPdf';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import {
  formatMarket,
  loadCellPatternSummary,
  loadCellsForScan,
  loadCompetitorSummary,
  loadNapFindingsSummary,
  type SupabaseClientLike,
} from './auditDataLoaders';
import type {
  ClientRow,
  LeadOrderRow,
  ScanRow,
  TrackedKeywordRow,
  VisibilityAuditRow,
} from '@/lib/supabase/types';

export type GenerateRoadmapResult =
  | {
      ok: true;
      pdfBuffer: Buffer;
      roadmapUrl: string;
      projectedTurfScore: number;
      ninetyDayTargetLift: number;
      businessName: string;
      trade: string;
      market: string;
      /** Full diagnosis blurb from the AI Roadmap Generator. The
       *  buyer-facing roadmap-ready email quotes the first sentence
       *  or two from this as a teaser; the PDF itself embeds the
       *  full text on the cover page. */
      diagnosis: string;
    }
  | { ok: false; stage: string; error: string };

export async function generateAndStoreRoadmapPdf(
  supabase: SupabaseClientLike,
  auditId: string
): Promise<GenerateRoadmapResult> {
  // ─── 1. Load the audit + its anchors ───────────────────────────────
  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('*')
    .eq('id', auditId)
    .maybeSingle<VisibilityAuditRow>();
  if (!audit) return { ok: false, stage: 'load-audit', error: 'audit not found' };

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', audit.client_id)
    .maybeSingle<ClientRow>();
  if (!client) return { ok: false, stage: 'load-client', error: 'client not found' };

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', audit.scan_id)
    .maybeSingle<ScanRow>();
  if (!scan) return { ok: false, stage: 'load-scan', error: 'scan not found' };

  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('client_id', audit.client_id)
    .eq('is_primary', true)
    .maybeSingle<TrackedKeywordRow>();

  // ─── 1b. Detect tier — for strategy, fetch the comparative data ───
  // The audit's lead_order tells us whether this is a 1-keyword
  // (audit) or 3-keyword (strategy) deliverable. Strategy buyers get
  // a cross-keyword landscape page in the PDF + a comparative
  // diagnosis blurb from the AI.
  const { data: leadOrder } = await supabase
    .from('lead_orders')
    .select('tier')
    .eq('id', audit.lead_order_id)
    .maybeSingle<Pick<LeadOrderRow, 'tier'>>();
  const isStrategyTier = leadOrder?.tier === 'strategy';
  const tierLabel =
    leadOrder?.tier === 'strategy' ? 'Strategy Session' : 'Visibility Audit';

  // ─── 1c. (Strategy only) Load secondary keywords + their scans ────
  // tracked_keywords carries all 3 for strategy buyers (1 primary +
  // 2 non-primary). For each non-primary, find the most recent
  // matching scan (one-keyword-many-scans is theoretically possible
  // for repeat scans; we want the latest). The scans tied to this
  // client + matching the secondary keyword text are the right ones.
  type SecondaryRow = {
    keyword: string;
    scanId: string;
    turfScore: number;
    turfReach: number | null;
    turfRank: number | null;
    cells: Array<{ x: number; y: number; rank: number | null }>;
  };
  const secondaries: SecondaryRow[] = [];
  if (isStrategyTier) {
    const { data: otherKeywords } = await supabase
      .from('tracked_keywords')
      .select('*')
      .eq('client_id', audit.client_id)
      .eq('is_primary', false)
      .order('created_at', { ascending: true });
    for (const k of (otherKeywords ?? []) as TrackedKeywordRow[]) {
      // Pick the freshest scan for this keyword. runScanForLocation
      // stamps keyword_id on each scan row, so the lookup is
      // index-friendly.
      const { data: kScan } = await supabase
        .from('scans')
        .select('id, turf_score, turf_reach, turf_rank')
        .eq('client_id', audit.client_id)
        .eq('keyword_id', k.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<
          Pick<ScanRow, 'id' | 'turf_score' | 'turf_reach' | 'turf_rank'>
        >();
      if (!kScan) continue;
      // Load this scan's cells too so the strategy landscape page can
      // render a mini-heatmap fingerprint per keyword. Empty array is
      // OK — the PDF falls back to a "scan data pending" placeholder.
      const cells = await loadCellsForScan(supabase, kScan.id);
      secondaries.push({
        keyword: k.keyword,
        scanId: kScan.id,
        turfScore: kScan.turf_score ?? 0,
        turfReach: kScan.turf_reach ?? null,
        turfRank: kScan.turf_rank ?? null,
        cells,
      });
    }
  }

  // ─── 2. Aggregate the buyer-specific input summaries ───────────────
  const napFindingsSummary = await loadNapFindingsSummary(
    supabase,
    audit.client_id
  );
  const competitorSummary = await loadCompetitorSummary(supabase, audit.scan_id);
  const cellPatternSummary = await loadCellPatternSummary(
    supabase,
    audit.scan_id
  );

  const startingTurfScore = audit.starting_turfscore ?? scan.turf_score ?? 0;
  const market = formatMarket(client);
  const trade = keyword?.keyword ?? client.business_name;

  // ─── 3. AI Roadmap generation (Claude) ─────────────────────────────
  // Strategy buyers: pass the secondary keywords' stats so the
  // diagnosis weaves in the cross-keyword pattern. The actions
  // themselves still target the primary keyword (matching the
  // single-keyword PDF + dashboard surfaces) — the comparative
  // framing lives in the diagnosis blurb on the cover.
  const aiSecondaries: RoadmapKeywordStats[] | null = isStrategyTier
    ? secondaries.map((s) => ({
        keyword: s.keyword,
        turfScore: s.turfScore,
        turfReach: s.turfReach,
        turfRank: s.turfRank,
      }))
    : null;

  let roadmap: Awaited<ReturnType<typeof generateRoadmap>>;
  try {
    roadmap = await generateRoadmap({
      businessName: client.business_name,
      trade,
      keyword: keyword?.keyword ?? '',
      market,
      currentTurfScore: startingTurfScore,
      turfReach: scan.turf_reach ?? null,
      turfRank: scan.turf_rank ?? null,
      napFindingsSummary,
      competitorSummary,
      cellPatternSummary,
      secondaryKeywords: aiSecondaries,
    });
  } catch (e) {
    return {
      ok: false,
      stage: 'generate-roadmap',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const projectedTurfScore = startingTurfScore + roadmap.thirtyDayTargetLift;

  // ─── 4. PDF render ─────────────────────────────────────────────────
  // Load the primary scan's cells once — used by BOTH the cover-page
  // heatmap (existing) and the landscape primary card (new). Pulling
  // it up here avoids two reads of the same scan_points block.
  const primaryCells = await loadCellsForScan(supabase, audit.scan_id);

  // ─── 4a. Competitor aggregation (TOP COMPETITORS page) ────────────
  // The Roadmap PDF's competitor section was rendering blank because
  // generateAndStoreRoadmapPdf hardcoded competitors=[] — but the
  // data IS available on scan_points.competitors. Read once, aggregate
  // via the shared aggregateCompetitors helper, surface the top 3 with
  // a heuristic per-competitor TurfScore estimate (we don't run a
  // separate scan per competitor; the deck-only estimate is calibrated
  // from share_pct × (1 - (avg_rank - 1) / 6), matching the formula
  // generate-ryan-audit-pdf.ts proved on Ryan's call deck).
  const compRows = await loadCompetitorRows(supabase, audit.scan_id);
  const aggregated = aggregateCompetitors(
    compRows.map((r) => ({ competitors: r.competitors })),
    Math.max(compRows.length, 1),
    {
      // Exclude the buyer's own brand from the competitor list — same
      // pattern the live dashboard uses on /clients/<id>.
      excludeNamePattern: businessNameAsRegex(client.business_name),
      topN: 3,
    }
  );
  const competitorsForPdf: RoadmapPdfCompetitor[] = aggregated.map((c) => ({
    name: c.name,
    turfScore: estimateCompetitorTurfScore(c.top3Pct, c.amr),
    differential: `Holds top-3 in ${c.top3Pct}% of the grid (avg rank ${c.amr.toFixed(2)})`,
  }));

  // ─── 4b. NAP findings (NAP AUDIT page) ────────────────────────────
  // The NAP audit's findings JSON is stored on nap_audits.findings as
  // the shape summarizeFindings emits — { citations[], inconsistencies[],
  // missing[] }. The PDF wants a flat list of {status, text} rows.
  // When no nap_audit row exists yet (cold-prospect comp audits that
  // haven't had a BL audit triggered), pass an empty array — the PDF
  // renders a "no findings yet" placeholder rather than fake data.
  const napFindings = await loadNapFindingsForPdf(supabase, audit.client_id);

  // Build the Strategy-tier keyword landscape: primary first
  // (annotated + lime highlight), then the secondaries with their own
  // mini-heatmap cells so the strategist call can point at three
  // visibility fingerprints side-by-side. For audit/scan, leave the
  // array empty so the PDF skips the landscape page entirely.
  const keywordLandscape: RoadmapPdfKeywordRow[] = [];
  if (isStrategyTier) {
    keywordLandscape.push({
      keyword: keyword?.keyword ?? trade,
      turfScore: startingTurfScore,
      turfReach: scan.turf_reach ?? null,
      turfRank: scan.turf_rank ?? null,
      note: 'Primary — the 90-day Roadmap on the following pages is framed around this keyword.',
      cells: primaryCells,
    });
    // Keep the order primary → angle #2 → angle #3 matching what the
    // buyer typed on intake (sorting by score reordered them, which
    // is confusing — the strategist call leans on the SAME ordering
    // the buyer used). The note column already differentiates
    // strongest vs weakest via the AI diagnosis on the cover.
    for (const s of secondaries) {
      keywordLandscape.push({
        keyword: s.keyword,
        turfScore: s.turfScore,
        turfReach: s.turfReach,
        turfRank: s.turfRank,
        cells: s.cells,
      });
    }
  }

  const pdfData: RoadmapPdfData = {
    businessName: client.business_name,
    trade,
    market,
    auditDate: new Date().toISOString().slice(0, 10),
    currentTurfScore: startingTurfScore,
    projectedTurfScore,
    diagnosis: roadmap.diagnosis,
    actions: roadmap.actions.map((a) => ({
      week: a.week,
      action: a.action,
      category: a.category,
      pillar: a.resolvedPillar,
      difficulty: a.difficulty,
      priority: a.priority,
      projectedScoreLift: a.projectedScoreLift,
      llmCovered: a.llmCovered,
    })),
    napFindings,
    competitors: competitorsForPdf,
    cells: primaryCells,
    keywordLandscape,
    tierLabel,
    ninetyDayTargetLift: roadmap.ninetyDayTargetLift,
  };

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderToBuffer(<RoadmapPdf data={pdfData} />);
  } catch (e) {
    return {
      ok: false,
      stage: 'render-pdf',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // ─── 5. Upload to Supabase Storage + sign URL ──────────────────────
  const upload = await uploadRoadmapPdf(supabase, {
    auditId: audit.id,
    pdfBuffer,
  });
  if (!upload.ok) {
    return { ok: false, stage: 'upload-pdf', error: upload.error };
  }
  const signed = await signedUrlForAuditFile(supabase, upload.path);
  if (!signed.ok) {
    return { ok: false, stage: 'sign-pdf', error: signed.error };
  }

  // ─── 6. Stamp the audit row ────────────────────────────────────────
  await patchVisibilityAudit(supabase, audit.id, {
    roadmap_pdf_url: signed.url,
    lift_promise_target_score: projectedTurfScore,
  });

  return {
    ok: true,
    pdfBuffer,
    roadmapUrl: signed.url,
    projectedTurfScore,
    ninetyDayTargetLift: roadmap.ninetyDayTargetLift,
    businessName: client.business_name,
    trade,
    market,
    diagnosis: roadmap.diagnosis,
  };
}

// ─── PDF data loaders ──────────────────────────────────────────────────
// SupabaseClientLike comes in via the auditDataLoaders import alongside
// formatMarket / loadCellPatternSummary / etc. — re-using it here
// keeps a single source of truth for the server-supabase type alias.

/** Pull every scan_points row for this scan with its competitors
 *  array so the per-cell dedupe inside aggregateCompetitors can
 *  collapse duplicate DFS payloads. */
async function loadCompetitorRows(
  supabase: SupabaseClientLike,
  scanId: string
): Promise<Array<{ competitors: unknown }>> {
  const { data } = await supabase
    .from('scan_points')
    .select('competitors')
    .eq('scan_id', scanId);
  return (data ?? []) as Array<{ competitors: unknown }>;
}

/** Convert a business name into a case-insensitive RegExp suitable for
 *  aggregateCompetitors' excludeNamePattern — strips punctuation +
 *  collapses whitespace so "Ainger Group Roofing & Exteriors" matches
 *  "Ainger Group Roofing and Exteriors" the way DFS records it back. */
function businessNameAsRegex(name: string): RegExp {
  const cleaned = name
    .replace(/[&]/g, 'and')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 4) // skip short/common tokens that'd over-match
    .slice(0, 2)
    .join('|');
  return new RegExp(cleaned || name, 'i');
}

/** Per-competitor TurfScore estimate for the deliverable PDF. We don't
 *  scan each competitor separately (that'd burn 81 DFS Live Mode
 *  requests per competitor); the estimate is a defensible heuristic
 *  calibrated from the Ryan / BVM Contracting call deck:
 *
 *    score = share_pct × (1 − (avg_rank − 1) / 6)
 *
 *  Sanity: share_pct=98.8 + avg_rank=1.6 → ~89. share_pct=42 +
 *  avg_rank=2.85 → ~29. Clamped to [0, 100]. */
function estimateCompetitorTurfScore(
  sharePct: number,
  avgRank: number
): number {
  const raw = sharePct * (1 - (avgRank - 1) / 6);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Load + flatten the most recent nap_audits row for this client into
 *  the {status, text} rows the PDF's PageNap renders. Returns []
 *  when no audit exists (cold-prospect comp audits where the BL
 *  audit hasn't been triggered/completed yet). */
async function loadNapFindingsForPdf(
  supabase: SupabaseClientLike,
  clientId: string
): Promise<RoadmapPdfNapFinding[]> {
  const { data: napRow } = await supabase
    .from('nap_audits')
    .select('findings')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ findings: unknown }>();
  if (!napRow?.findings) return [];

  // Shape: { citations: {directory, status}[], inconsistencies:
  // {directory, field, canonical, found}[], missing:
  // {directory, priority}[] }. Defensive parsing — the JSONB can
  // technically be anything; cast carefully + skip malformed entries.
  const f = napRow.findings as {
    citations?: Array<{
      directory?: string;
      status?: 'matched' | 'mismatch' | 'unverified';
    }>;
    inconsistencies?: Array<{
      directory?: string;
      field?: string;
    }>;
    missing?: Array<{
      directory?: string;
      priority?: 'high' | 'medium' | 'low';
    }>;
  };

  const rows: RoadmapPdfNapFinding[] = [];

  // Inconsistencies first (most actionable), cap at 4.
  for (const i of (f.inconsistencies ?? []).slice(0, 4)) {
    if (!i.directory) continue;
    rows.push({
      status: 'INCONSISTENT',
      text: `${i.directory} — ${i.field ?? 'NAP'} differs from canonical`,
    });
  }
  // High-priority missing next, then any other missing — combined cap
  // so the page stays at ~10 rows total.
  const highPriorityMissing = (f.missing ?? [])
    .filter((m) => m.priority === 'high')
    .slice(0, 6);
  const otherMissing = (f.missing ?? [])
    .filter((m) => m.priority !== 'high')
    .slice(0, Math.max(0, 10 - rows.length - highPriorityMissing.length));
  for (const m of [...highPriorityMissing, ...otherMissing]) {
    if (!m.directory) continue;
    rows.push({ status: 'MISSING', text: m.directory });
  }
  // Live citations close the section — proof of progress.
  for (const c of (f.citations ?? [])
    .filter((c) => c.status === 'matched')
    .slice(0, 3)) {
    if (!c.directory) continue;
    rows.push({
      status: 'LIVE',
      text: `${c.directory} — NAP consistent`,
    });
  }
  return rows;
}
