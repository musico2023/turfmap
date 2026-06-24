/**
 * RoadmapPdf — the 90-Day Visibility Roadmap delivered as part of
 * the $499 Visibility Audit (and the $197 upgrade).
 *
 * Six pages, dark theme, brand parity with TurfReport.tsx (the
 * single-page TurfScan PDF). v1: no heatmap thumbnails on page 2 —
 * those are deferred to v1.1 once we have a server-side
 * heatmap-to-PNG renderer. v1 is text + tables + a bar chart, fully
 * legible on its own.
 *
 * Page map:
 *   1. Cover + score snapshot + Lift Promise statement
 *   2. The Visibility Gap — diagnosis + competitor TurfScores
 *   3. NAP audit findings
 *   4. The 90-day Roadmap table (12 weeks × 3 phases)
 *   5. Cumulative impact projection (bar chart) + 3-pillar context
 *   6. LLM segue page — three-pillar layout matching
 *      fourdots.io/home-services Section 04
 *
 * The "What's Next" page from the original spec (post-call summary,
 * 60-day check-in scheduled, lift-promise checklist) is deferred to
 * Phase 3 — those fields don't exist until after the strategist
 * call lands. Adding them as a placeholder page would generate dead
 * weight in the v1 deliverable.
 *
 * Pure presentation — no DB / file-system / network access. Caller
 * passes a typed `RoadmapPdfData` payload built upstream from
 * generateRoadmap() output + the buyer's audit data.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Svg,
  Rect,
  Line,
  Circle,
  G,
} from '@react-pdf/renderer';
import { BrandLogo } from './BrandLogo';
import {
  BRAND_FONT_FAMILY,
  registerBrandFonts,
} from './registerBrandFonts';

// Font registration must run before any <Page> is constructed.
// Idempotent — safe to call from multiple PDF modules in the same
// Node process.
registerBrandFonts();
import {
  ACTION_CATEGORY_BY_ID,
  PILLAR_LABEL,
  type Pillar,
} from '@/lib/audit/actionCategories';
import type {
  ActionCategory,
  ActionPriority,
  DifficultyRating,
} from '@/lib/supabase/types';

// ─── Color tokens (brand parity with TurfReport.tsx) ──────────────────

const C = {
  bg: '#0a0a0a',
  card: '#0d0d0d',
  cardGlow: '#0f1208',
  border: '#27272a',
  borderBright: '#2d3a14',
  lime: '#c5ff3a',
  warn: '#ff9f3a',
  bad: '#ff4d4d',
  text: '#ededed',
  textDim: '#a1a1aa',
  textMuted: '#71717a',
  textFaint: '#52525b',
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: C.bg,
    color: C.text,
    padding: 36,
    fontSize: 9,
    fontFamily: BRAND_FONT_FAMILY,
  },

  // ─── Header / footer ────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 14,
    borderBottom: `1px solid ${C.border}`,
    marginBottom: 18,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandTitle: { fontSize: 16, fontWeight: 700, color: C.text },
  brandSub: { fontSize: 7, color: C.textMuted, letterSpacing: 1.6 },
  headerRight: {
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  headerRightTitle: { fontSize: 9, color: C.text, fontWeight: 700 },
  headerRightSub: { fontSize: 7, color: C.textMuted, marginTop: 2 },
  pageLabel: {
    fontSize: 7,
    color: C.textMuted,
    letterSpacing: 1.6,
    marginTop: 1,
  },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: C.textFaint,
  },

  // ─── Generic ────────────────────────────────────────────────────────
  h1: { fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 4 },
  h2: { fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 },
  h3: {
    fontSize: 8,
    fontWeight: 700,
    color: C.lime,
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  body: { fontSize: 10, color: C.textDim, lineHeight: 1.5 },
  bodyTight: { fontSize: 9, color: C.textDim, lineHeight: 1.4 },
  italic: { fontStyle: 'italic' },

  // ─── Page 1 — cover ─────────────────────────────────────────────────
  // Tightened from the v1 first-render: page now also carries the
  // heatmap so the title block needs to step out of the way. Title
  // shrinks from 28→24pt, hero margins compact, sub copy moves up.
  coverHero: { marginTop: 8, marginBottom: 14 },
  coverEyebrow: {
    fontSize: 8,
    color: C.lime,
    letterSpacing: 2,
    marginBottom: 6,
    fontWeight: 700,
  },
  coverTitle: {
    fontSize: 24,
    fontWeight: 700,
    color: C.text,
    lineHeight: 1.1,
    marginBottom: 8,
  },
  coverSub: {
    fontSize: 10,
    color: C.textDim,
    lineHeight: 1.5,
    marginBottom: 2,
  },

  scoreRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 0,
    marginBottom: 12,
  },
  scoreCell: {
    flex: 1,
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 10,
  },
  scoreCellHi: {
    flex: 1,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 10,
  },
  scoreLabel: {
    fontSize: 7,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  scoreValue: { fontSize: 24, color: C.text, fontWeight: 700, lineHeight: 1 },
  scoreValueLime: {
    fontSize: 24,
    color: C.lime,
    fontWeight: 700,
    lineHeight: 1,
  },
  scoreSub: { fontSize: 8, color: C.textMuted, marginTop: 4 },

  // Cover-page heatmap container. Sits between the title block and
  // the score cards so the buyer's first visceral impression of the
  // document is "yes, that's actually my map" rather than "yet
  // another deliverable."
  coverHeatmapBox: {
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
    marginBottom: 16,
  },
  coverHeatmapLabel: {
    fontSize: 7,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 8,
    fontWeight: 700,
  },
  coverHeatmapLegend: {
    fontSize: 7,
    color: C.textFaint,
    marginTop: 8,
    textAlign: 'center',
  },
  promiseBox: {
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 14,
    marginTop: 10,
  },
  promiseLabel: {
    fontSize: 7,
    color: C.lime,
    letterSpacing: 1.6,
    fontWeight: 700,
    marginBottom: 4,
  },
  promiseText: { fontSize: 11, color: C.text, lineHeight: 1.5 },

  // ─── Page 2 — gap ───────────────────────────────────────────────────
  diagnosisBox: {
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 14,
    marginBottom: 14,
  },
  diagnosisLabel: {
    fontSize: 7,
    color: C.lime,
    letterSpacing: 1.4,
    fontWeight: 700,
    marginBottom: 6,
  },
  diagnosisText: {
    fontSize: 11,
    color: C.text,
    lineHeight: 1.5,
    fontStyle: 'italic',
  },

  competitorRow: {
    flexDirection: 'row',
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
    marginBottom: 6,
    // alignItems: 'flex-start' so the rank number sits at the top of
    // the row and the inner name/differential column flows beneath
    // each other naturally. The previous 'center' was collapsing the
    // inner column and overlapping name + differential on the first
    // render.
    alignItems: 'flex-start',
  },
  competitorRank: {
    fontSize: 18,
    color: C.textMuted,
    fontWeight: 700,
    width: 28,
    paddingTop: 1,
  },
  competitorBody: {
    flex: 1,
    flexDirection: 'column',
    paddingRight: 12,
  },
  competitorName: {
    fontSize: 11,
    color: C.text,
    fontWeight: 700,
    marginBottom: 3,
  },
  competitorDiff: {
    fontSize: 8.5,
    color: C.textDim,
    lineHeight: 1.45,
  },
  competitorScore: { fontSize: 18, color: C.lime, fontWeight: 700, paddingTop: 1 },

  compoundCallout: {
    backgroundColor: C.cardGlow,
    borderLeft: `2px solid ${C.lime}`,
    paddingLeft: 10,
    paddingTop: 8,
    paddingBottom: 8,
    marginTop: 14,
    fontSize: 9,
    color: C.textDim,
    lineHeight: 1.5,
    fontStyle: 'italic',
  },

  // ─── Page 3 — NAP findings ──────────────────────────────────────────
  napTable: {
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
  },
  napFinding: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottom: `1px solid ${C.border}`,
  },
  napStatusPill: {
    fontSize: 7,
    fontWeight: 700,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 3,
    marginRight: 10,
    // Wide enough that "MISMATCH" + "MISSING" + "LIVE" all fit on a
    // single line without the 'INCONSISTENT' wrapping bug we saw on
    // the first render. Using "MISMATCH" instead of "INCONSISTENT"
    // is a deliberate copy choice — same meaning, half the chars,
    // and reads as more concrete to a non-technical buyer.
    width: 72,
    textAlign: 'center',
  },
  napText: { fontSize: 9, color: C.text, flex: 1, lineHeight: 1.4 },

  // ─── Page 4 — Roadmap table ─────────────────────────────────────────
  phaseHeader: {
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 10,
    marginBottom: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  phaseTitle: { fontSize: 10, color: C.lime, fontWeight: 700 },
  phaseRange: { fontSize: 8, color: C.textMuted, letterSpacing: 1.2 },
  roadmapRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderBottom: `1px solid ${C.border}`,
    alignItems: 'flex-start',
  },
  rmWeek: {
    width: 22,
    fontSize: 9,
    color: C.textMuted,
    fontWeight: 700,
    paddingTop: 1,
  },
  rmAction: { flex: 1, fontSize: 8.5, color: C.text, lineHeight: 1.4, paddingRight: 6 },
  rmDifficulty: {
    width: 56,
    fontSize: 7,
    color: C.textMuted,
    textAlign: 'right',
    paddingTop: 1,
  },
  rmLift: {
    width: 36,
    fontSize: 9,
    color: C.lime,
    fontWeight: 700,
    textAlign: 'right',
    paddingTop: 1,
  },
  rmPillarCell: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 1,
  },
  // Pillar badges. Each replaces what was a single lime "this is LLM"
  // tag with a three-color taxonomy that matches the Demand /
  // Visibility / Systems pillar architecture. The Visibility pillar
  // (the focus of this Roadmap) keeps the lime accent so it visually
  // dominates; Demand and Systems get distinct accents so the buyer
  // can scan which pillar each action sits under.
  //
  // The badge is a flex-centered View+Text pair (rather than a styled
  // Text alone) because react-pdf's vertical text-centering via
  // lineHeight is unreliable across the SDK's font-metric variants —
  // the v1.2 render had the V/D/S letters sitting visibly off-center
  // top. Flex centering produces deterministic alignment.
  pillarBadgeBox: {
    width: 18,
    height: 18,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillarBadgeText: {
    fontSize: 9,
    fontWeight: 700,
    lineHeight: 1,
  },
  // Page-4 legend row that introduces the V/D/S badge taxonomy.
  // Inline beneath the H2 so the buyer sees the key before parsing
  // the table — no need to scroll back up to figure out what a
  // colored letter means.
  legendRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 6,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillarBadgeSmBox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillarBadgeSmText: {
    fontSize: 7,
    fontWeight: 700,
    lineHeight: 1,
  },
  legendLabel: {
    fontSize: 8.5,
    color: C.textDim,
  },
  priorityPill: {
    width: 36,
    fontSize: 6.5,
    fontWeight: 700,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 2,
    textAlign: 'center',
    marginRight: 6,
  },

  llmCallout: {
    marginTop: 14,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 10,
    fontSize: 8.5,
    color: C.textDim,
    lineHeight: 1.5,
  },

  // ─── Page 5 — projection chart ──────────────────────────────────────
  chartBox: {
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 16,
    marginBottom: 14,
  },
  chartLabel: {
    fontSize: 7,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 10,
  },

  pillarRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  pillarMini: {
    flex: 1,
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 10,
    alignItems: 'center',
  },
  pillarMiniAccent: {
    flex: 1,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 10,
    alignItems: 'center',
  },
  // Pillar marker squares for the page-5 mini-row. Color comes from
  // PILLAR_PALETTE so the visual taxonomy matches the page-4 row
  // badges 1:1. The previous "muted gray for non-Visibility pillars"
  // treatment broke the link — buyers couldn't tell that a D badge
  // on page 4 corresponded to the demand pillar on page 5/6.
  pillarMiniDot: {
    width: 10,
    height: 10,
    borderRadius: 2,
    marginBottom: 6,
  },
  pillarMiniTitle: { fontSize: 8, color: C.text, fontWeight: 700 },
  pillarMiniSub: {
    fontSize: 7,
    color: C.textMuted,
    marginTop: 2,
    textAlign: 'center',
    lineHeight: 1.4,
  },

  // ─── Page 6 — LLM pillar segue ──────────────────────────────────────
  pillar3Row: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    marginBottom: 14,
  },
  pillarBox: {
    flex: 1,
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
  },
  pillarBoxAccent: {
    flex: 1,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.lime}`,
    borderRadius: 6,
    padding: 12,
  },
  pillarIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  // Page-6 pillar-box markers. Color comes per-call from
  // PILLAR_PALETTE so the V/D/S taxonomy stays consistent with the
  // page-4 row badges + page-5 mini-row dots. (The accented lime
  // border on the VISIBILITY box still carries the "your pillar"
  // emphasis — the marker square just identifies the pillar.)
  pillarSquare: {
    width: 14,
    height: 14,
    borderRadius: 3,
  },
  pillarTitle: { fontSize: 11, color: C.text, fontWeight: 700 },
  pillarItem: {
    fontSize: 7.5,
    color: C.textDim,
    lineHeight: 1.5,
    marginBottom: 3,
  },
  // Lime, uppercase, letterspaced — reads as a tag/callout for the
  // accented VISIBILITY pillar without leaning on a Unicode arrow
  // glyph the PDF font doesn't have.
  pillarOurs: {
    fontSize: 7,
    color: C.lime,
    fontWeight: 700,
    marginTop: 8,
    paddingTop: 6,
    borderTop: `1px solid ${C.borderBright}`,
    letterSpacing: 1.4,
    textAlign: 'center',
  },

  qualifyBox: {
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  },
  qualifyTitle: {
    fontSize: 7,
    color: C.lime,
    letterSpacing: 1.4,
    fontWeight: 700,
    marginBottom: 8,
  },
  qualifyRow: {
    flexDirection: 'row',
    paddingVertical: 3,
  },
  qualifyBox_check: {
    width: 12,
    height: 12,
    borderRadius: 3,
    border: `1px solid ${C.border}`,
    marginRight: 8,
  },
  qualifyText: { fontSize: 9, color: C.textDim, flex: 1, lineHeight: 1.4 },

  closingBlock: {
    fontSize: 9,
    color: C.textDim,
    lineHeight: 1.5,
    marginTop: 6,
  },
});

// ─── Public types (caller assembles RoadmapPdfData upstream) ──────────

export type RoadmapPdfAction = {
  week: number;
  action: string;
  category: ActionCategory;
  /** LLM pillar (V/D/S). Drives the colored badge on each row. All
   *  pillars are LLM-covered; the badge replaces the previous
   *  "lime-tagged = LLM, untagged = not LLM" framing because that
   *  framing was wrong (LLM covers all three pillars). */
  pillar: Pillar;
  difficulty: DifficultyRating;
  priority: ActionPriority;
  projectedScoreLift: number;
  /** Retained for backwards-compat; effectively true for every
   *  action under the new pillar model. */
  llmCovered: boolean;
};

export type RoadmapPdfNapFinding = {
  /** Status pill text. LIVE = listing found AND NAP verified; FOUND =
   *  listing exists (name matched) but NAP couldn't be confirmed from the
   *  search snippet — NOT missing; MISSING = no listing surfaced;
   *  INCONSISTENT = NAP conflict. */
  status: 'MISSING' | 'INCONSISTENT' | 'LIVE' | 'FOUND';
  /** Free-text body, e.g., "Yelp — phone differs from GBP". */
  text: string;
};

export type RoadmapPdfCompetitor = {
  name: string;
  turfScore: number;
  /** Optional short differential blurb, e.g., "380 reviews vs. your 218". */
  differential?: string;
};

/** Per-keyword scan summary for the Strategy Session ($1,497)
 *  3-keyword comparative landscape page. Empty / absent on Audit +
 *  Scan tiers (single-keyword roadmaps). */
export type RoadmapPdfKeywordRow = {
  keyword: string;
  /** TurfScore on the scan for this keyword. */
  turfScore: number;
  /** TurfReach % (cells where buyer appears in pack). NULL when
   *  scan stats aren't computed yet. */
  turfReach: number | null;
  /** TurfRank (avg pack position when present, 0-3). */
  turfRank: number | null;
  /** Brief operator-facing note rendered alongside the row — e.g.,
   *  "Strongest current visibility" / "Largest opportunity gap" /
   *  "Most contested". Optional; the row reads fine without it. */
  note?: string;
  /** 81 cells from this keyword's scan. Drives the mini-heatmap on
   *  the landscape page so the buyer + strategist see how visibility
   *  differs between keywords at a glance. Empty / absent falls
   *  back to a label-only rendering. */
  cells?: RoadmapPdfCell[];
};

/** One cell on the 9x9 grid. Mirrors the shape used by TurfReport.tsx
 *  so a future shared module could deduplicate. `rank` is null when
 *  the buyer doesn't appear in the local pack at all for that cell;
 *  1-3 means top-3 pack, 4-10 = top-10, 11-20 = top-20, >20 = absent. */
export type RoadmapPdfCell = {
  x: number;
  y: number;
  rank: number | null;
};

export type RoadmapPdfData = {
  businessName: string;
  trade: string;
  market: string;
  /** Date string for the cover ("May 9, 2026"). */
  auditDate: string;
  currentTurfScore: number;
  /** Projected 30-day target. The Lift Promise hinges on this number
   *  clearing current+10. Caller already validated that. */
  projectedTurfScore: number;
  /** AI-generated diagnosis from generateRoadmap(). */
  diagnosis: string;
  /** All 8-15 actions across the 12 weeks, sorted by week then priority. */
  actions: RoadmapPdfAction[];
  napFindings: RoadmapPdfNapFinding[];
  competitors: RoadmapPdfCompetitor[];
  /** 81 cells of the geo-grid scan, one per search point on the 9x9
   *  grid. Optional: when null/empty, page 1 omits the heatmap and
   *  falls back to the score cards alone. Production fulfillment
   *  pulls these from the buyer's scan_points table; the dev fixture
   *  synthesizes them from the cell-pattern summary. */
  cells?: RoadmapPdfCell[];
  /** Sums computed by the AI generator. The phase totals (4w / 8w /
   *  12w) drive the bar chart on page 5; we recompute here from
   *  actions[] to stay decoupled from the upstream sum logic. */
  ninetyDayTargetLift: number;
  /** Strategy-tier 3-keyword landscape. When non-empty, the PDF
   *  inserts a "Keyword Landscape" page between the cover and the
   *  TurfGap page that compares all three keywords' visibility
   *  side-by-side. Empty / absent for Scan + Audit tiers. */
  keywordLandscape?: RoadmapPdfKeywordRow[];
  /** Human-readable tier label — drives the cover-page badge ("90-Day
   *  Roadmap · Strategy Session" vs ". Visibility Audit"). Optional;
   *  the existing rendering still works without it. */
  tierLabel?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────

function priorityStyle(p: ActionPriority): { bg: string; fg: string } {
  if (p === 'HIGH') return { bg: C.lime, fg: '#000' };
  if (p === 'MEDIUM') return { bg: C.warn, fg: '#000' };
  return { bg: '#3a3a3a', fg: '#999' };
}

/**
 * Pillar palette — single source of truth for the V/D/S colorway.
 * Used by:
 *   - page-4 row badges + legend
 *   - page-5 mini-pillar dot row
 *   - page-6 large pillar-box squares
 * Keeping all three sites on the same constants means the buyer's
 * visual taxonomy stays coherent: a lime mark on page 4 ties to a
 * lime square on page 5/6 ties back to the V badge.
 *   - Visibility (lime): this Roadmap's focus — visually dominant
 *   - Demand (cyan-ish blue): paid-traffic + conversion side
 *   - Systems (lavender): infrastructure / workflow side
 */
const PILLAR_PALETTE: Readonly<Record<Pillar, { bg: string; fg: string }>> =
  Object.freeze({
    visibility: { bg: C.lime, fg: '#000' },
    demand: { bg: '#4adcff', fg: '#001d2a' },
    systems: { bg: '#c19bff', fg: '#1a0d2a' },
  });

function pillarStyle(p: Pillar): { bg: string; fg: string } {
  return PILLAR_PALETTE[p];
}

function napStatusStyle(s: RoadmapPdfNapFinding['status']): {
  bg: string;
  fg: string;
} {
  if (s === 'LIVE') return { bg: '#1a3a14', fg: C.lime };
  if (s === 'FOUND') return { bg: '#1c2a38', fg: '#7ca8c4' };
  if (s === 'INCONSISTENT') return { bg: '#3a2614', fg: C.warn };
  return { bg: '#3a1a1a', fg: C.bad };
}

function phaseSliceLift(
  actions: RoadmapPdfAction[],
  fromWeek: number,
  toWeek: number
): number {
  return actions
    .filter((a) => a.week >= fromWeek && a.week <= toWeek)
    .reduce((sum, a) => sum + a.projectedScoreLift, 0);
}

// ─── Reusable sub-components ──────────────────────────────────────────

function Header({
  data,
  pageLabel,
}: {
  data: RoadmapPdfData;
  pageLabel: string;
}) {
  return (
    <View style={styles.header} fixed>
      <View style={styles.brand}>
        <BrandLogo size={22} />
        <View>
          <Text style={styles.brandTitle}>TurfMap™</Text>
          <Text style={styles.brandSub}>90-DAY VISIBILITY ROADMAP</Text>
        </View>
      </View>
      <View style={styles.headerRight}>
        <Text style={styles.headerRightTitle}>{data.businessName}</Text>
        <Text style={styles.headerRightSub}>{data.auditDate}</Text>
        <Text style={styles.pageLabel}>{pageLabel}</Text>
      </View>
    </View>
  );
}

function Footer() {
  return (
    <View style={styles.footer} fixed>
      <Text>TurfMap™ — proprietary technology of Fourdots Digital</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `${pageNumber} / ${totalPages}`
        }
      />
    </View>
  );
}

// ─── Cover heatmap (compact 9x9) ──────────────────────────────────────
//
// Smaller-than-TurfReport's-version-on-purpose. The TurfReport PDF
// renders a 320pt-wide hero heatmap; the Roadmap cover is already
// dense (title + heatmap + score cards + Lift Promise + footer) so
// this gets a tighter ~280pt canvas + smaller cell radius. Same
// rank-color tiers as the dashboard so the document reads as
// continuous with the live product.

const COVER_GRID = 9;
const COVER_CANVAS = 280;
const COVER_CELL = COVER_CANVAS / COVER_GRID; // ~31pt
const COVER_CELL_R = COVER_CELL * 0.42;

// Heatmap rank → color + label, matched 1:1 with the dashboard's
// HeatmapGrid component (components/turfmap/HeatmapGrid.tsx). The
// dashboard treats a cell as a 4-state: visible at position 1, 2, or
// 3 in Google's local pack — or absent (null). There is no "ranked
// 4+" tier because Google's local pack only exposes top-3 to
// searchers; anything beyond is either not surfaced or not relevant
// to the buyer's visibility decisioning.
//
// The previous PDF version (v1.2) was leaking the synthesizer's
// rank-4-through-20 tiers into the heatmap, producing yellow/orange
// circles WITHOUT labels — confusing to a buyer who sees the same
// heatmap on the dashboard with a clean 1/2/3/— treatment. This
// brings the PDF + dashboard into visual parity.
function rankColor(rank: number | null): string {
  if (rank === null) return C.bad; // not in 3-pack → red
  if (rank === 1) return C.lime;
  if (rank === 2) return '#e8e54a'; // yellow
  if (rank === 3) return C.warn; // orange
  // Defensive — synthesizer should never emit ranks > 3 anymore,
  // but if a cell slips through (e.g. real scan data with stale
  // out-of-pack ranks), treat it the same as "not in 3-pack."
  return C.bad;
}

function rankLabel(rank: number | null): string {
  if (rank === null) return '—';
  if (rank > 3) return '—'; // see rankColor — defensive fallthrough
  return String(rank);
}

/**
 * Compact 9×9 heatmap used on the Strategy Session landscape page.
 * Same color + label semantics as CoverHeatmap, scaled down to fit
 * 3 keyword cards across a letter-page width. No grid lines (visual
 * noise at this size) + no center pin (the comparative beat is
 * "compare these three patterns," not "locate your business").
 */
function MiniHeatmap({
  cells,
  size,
}: {
  cells: RoadmapPdfCell[];
  size: number;
}) {
  const cellSize = size / COVER_GRID;
  const cellR = cellSize * 0.42;
  return (
    <Svg width={size} height={size}>
      {cells.map((c) => {
        const cx = cellSize / 2 + c.x * cellSize;
        const cy = cellSize / 2 + c.y * cellSize;
        const color = rankColor(c.rank);
        return (
          <G key={`${c.x}-${c.y}`}>
            <Circle cx={cx} cy={cy} r={cellR} fill={color} fillOpacity={0.96} />
          </G>
        );
      })}
    </Svg>
  );
}

function CoverHeatmap({ cells }: { cells: RoadmapPdfCell[] }) {
  return (
    <Svg width={COVER_CANVAS} height={COVER_CANVAS}>
      {/* Faint grid lines so the 9x9 structure reads even with
       *  empty cells. Intentionally subtle — same #1f1f1f shade
       *  TurfReport.tsx uses. */}
      {Array.from({ length: COVER_GRID + 1 }).map((_, i) => (
        <G key={`grid-${i}`}>
          <Line
            x1={i * COVER_CELL}
            y1={0}
            x2={i * COVER_CELL}
            y2={COVER_CANVAS}
            stroke="#1f1f1f"
            strokeWidth={1}
          />
          <Line
            x1={0}
            y1={i * COVER_CELL}
            x2={COVER_CANVAS}
            y2={i * COVER_CELL}
            stroke="#1f1f1f"
            strokeWidth={1}
          />
        </G>
      ))}

      {cells.map((c) => {
        const cx = COVER_CELL / 2 + c.x * COVER_CELL;
        const cy = COVER_CELL / 2 + c.y * COVER_CELL;
        const color = rankColor(c.rank);
        // Every cell carries a label now — '1' / '2' / '3' for
        // visible-in-pack cells, '—' for absent. Mirrors the
        // dashboard's HeatmapGrid 1:1 so a buyer flipping between
        // the PDF and the live product sees identical glyphs +
        // colors.
        return (
          <G key={`${c.x}-${c.y}`}>
            <Circle cx={cx} cy={cy} r={COVER_CELL_R} fill={color} fillOpacity={0.96} />
            <Text
              x={cx}
              y={cy + 3.5}
              textAnchor="middle"
              style={{ fontSize: 11, fontWeight: 700 }}
              fill="black"
            >
              {rankLabel(c.rank)}
            </Text>
          </G>
        );
      })}

      {/* center pin */}
      <Circle
        cx={COVER_CANVAS / 2}
        cy={COVER_CANVAS / 2}
        r={8}
        fill="white"
        stroke="black"
        strokeWidth={2}
      />
      <Circle
        cx={COVER_CANVAS / 2}
        cy={COVER_CANVAS / 2}
        r={3.5}
        fill="black"
      />
    </Svg>
  );
}

// ─── Page 1: cover + snapshot ─────────────────────────────────────────

function PageCover({ data }: { data: RoadmapPdfData }) {
  // `lift` still drives the "+X pts projected from this Roadmap"
  // score-cell sub-label. The article-aware copy ("a 10-point lift"
  // vs "an 8-point lift") that lived in the now-removed Lift Promise
  // box was dropped along with the box itself.
  const lift = data.projectedTurfScore - data.currentTurfScore;
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="COVER" />

      <View style={styles.coverHero}>
        <Text style={styles.coverEyebrow}>
          {(data.tierLabel ?? 'VISIBILITY AUDIT').toUpperCase()} — 90-DAY ROADMAP
        </Text>
        {/* Line break after "don't." per the buyer-readability pass.
         *  The previous single-line title wrapped awkwardly at the
         *  page-margin breakpoint; explicit two-line layout keeps
         *  the rhetorical beat ("where you win / where you don't /
         *  what to do next") intact regardless of viewport width. */}
        <Text style={styles.coverTitle}>
          Where you win. Where you don&apos;t.{'\n'}
          What to do next.
        </Text>
        <Text style={styles.coverSub}>
          {data.businessName} — {data.trade} in {data.market}
        </Text>
        <Text style={styles.coverSub}>
          81-point geo-grid scan, completed {data.auditDate}.
        </Text>
      </View>

      {data.cells && data.cells.length > 0 ? (
        <View style={styles.coverHeatmapBox}>
          <Text style={styles.coverHeatmapLabel}>
            CURRENT TERRITORY HEATMAP — 81 SEARCH POINTS, 1.6mi RADIUS
          </Text>
          <View style={{ alignItems: 'center' }}>
            <CoverHeatmap cells={data.cells} />
          </View>
          <Text style={styles.coverHeatmapLegend}>
            1 = top of pack (lime) · 2 = second (yellow) · 3 = third (orange) · — = not in 3-pack (red)
          </Text>
        </View>
      ) : null}

      <View style={styles.scoreRow}>
        <View style={styles.scoreCell}>
          <Text style={styles.scoreLabel}>CURRENT TURFSCORE</Text>
          <Text style={styles.scoreValue}>{data.currentTurfScore}</Text>
          <Text style={styles.scoreSub}>composite visibility, 0–100</Text>
        </View>
        <View style={styles.scoreCellHi}>
          <Text style={styles.scoreLabel}>30-DAY TARGET</Text>
          <Text style={styles.scoreValueLime}>{data.projectedTurfScore}</Text>
          <Text style={styles.scoreSub}>
            +{lift} pts projected from this Roadmap
          </Text>
        </View>
      </View>

      {/* TurfScore Lift Promise was removed from the deliverable PDF
       *  per operator decision — it lives in marketing surfaces
       *  (homepage, /scan, PricingCards, audit-purchase emails) only,
       *  not in the Roadmap PDF the strategist hands to the buyer.
       *  The buyer-facing artifact stays focused on diagnosis +
       *  actions, not the refund mechanic. The unused liftArticle
       *  computation upstream is kept for any future cover treatment
       *  that wants the article-aware copy back. */}

      <Footer />
    </Page>
  );
}

// ─── Page 2: the visibility gap ───────────────────────────────────────

function PageGap({ data }: { data: RoadmapPdfData }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="THE VISIBILITY GAP" />

      <Text style={styles.h2}>The visibility gap</Text>

      <View style={styles.diagnosisBox}>
        <Text style={styles.diagnosisLabel}>DIAGNOSIS</Text>
        <Text style={styles.diagnosisText}>{data.diagnosis}</Text>
      </View>

      <Text style={styles.h3}>TOP COMPETITORS</Text>

      {data.competitors.length === 0 ? (
        <Text style={styles.bodyTight}>
          No competitor data captured during this audit.
        </Text>
      ) : (
        data.competitors.slice(0, 3).map((c, i) => (
          <View key={i} style={styles.competitorRow} wrap={false}>
            <Text style={styles.competitorRank}>{i + 1}</Text>
            <View style={styles.competitorBody}>
              <Text style={styles.competitorName}>{c.name}</Text>
              {c.differential ? (
                <Text style={styles.competitorDiff}>{c.differential}</Text>
              ) : null}
            </View>
            <Text style={styles.competitorScore}>{c.turfScore}</Text>
          </View>
        ))
      )}

      <Text style={styles.compoundCallout}>
        Visibility gaps compound. Each month dark cells stay dark, the
        harder they are to recover — competitors accumulate review
        velocity, directory authority, and pack momentum that&apos;s
        priced into search rankings well past the surface metrics.
      </Text>

      <Footer />
    </Page>
  );
}

// ─── Page 3: NAP findings ─────────────────────────────────────────────

function PageNap({ data }: { data: RoadmapPdfData }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="NAP AUDIT FINDINGS" />

      <Text style={styles.h2}>NAP audit findings</Text>
      <Text style={[styles.bodyTight, { marginBottom: 12 }]}>
        Name / Address / Phone consistency across the directories that
        matter for {data.trade}. Missing listings are claimable; flagged
        inconsistencies suppress local-pack ranking authority.
      </Text>

      <View style={styles.napTable}>
        {data.napFindings.length === 0 ? (
          <Text style={styles.bodyTight}>
            NAP audit data unavailable for this scan. Your strategist
            will surface findings live on the call.
          </Text>
        ) : (
          data.napFindings.map((f, i) => {
            const s = napStatusStyle(f.status);
            // Display label is decoupled from the canonical status
            // value so we keep type strictness internally while
            // shipping shorter, more buyer-readable pills.
            // INCONSISTENT → MISMATCH (8 chars vs. 12, fits the pill).
            const pillLabel =
              f.status === 'INCONSISTENT' ? 'MISMATCH' : f.status;
            return (
              <View key={i} style={styles.napFinding}>
                <Text
                  style={[
                    styles.napStatusPill,
                    { backgroundColor: s.bg, color: s.fg },
                  ]}
                >
                  {pillLabel}
                </Text>
                <Text style={styles.napText}>{f.text}</Text>
              </View>
            );
          })
        )}
      </View>

      <Footer />
    </Page>
  );
}

// ─── Page 4: roadmap table ────────────────────────────────────────────

function PageRoadmap({ data }: { data: RoadmapPdfData }) {
  const phases: Array<{ title: string; range: string; from: number; to: number }> = [
    { title: 'Phase 1 — Foundation', range: 'WEEKS 1–4', from: 1, to: 4 },
    { title: 'Phase 2 — Authority', range: 'WEEKS 5–8', from: 5, to: 8 },
    { title: 'Phase 3 — Optimization', range: 'WEEKS 9–12', from: 9, to: 12 },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="THE 90-DAY ROADMAP" />

      <Text style={styles.h2}>The 90-day Roadmap</Text>
      <Text style={[styles.bodyTight, { marginBottom: 4 }]}>
        Each row carries a projected TurfScore lift in points and a
        pillar badge:
      </Text>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.pillarBadgeSmBox, { backgroundColor: C.lime }]}>
            <Text style={[styles.pillarBadgeSmText, { color: '#000' }]}>V</Text>
          </View>
          <Text style={styles.legendLabel}>Visibility — your Roadmap&apos;s focus</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.pillarBadgeSmBox, { backgroundColor: '#4adcff' }]}>
            <Text style={[styles.pillarBadgeSmText, { color: '#001d2a' }]}>D</Text>
          </View>
          <Text style={styles.legendLabel}>Demand — paid traffic + conversion</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.pillarBadgeSmBox, { backgroundColor: '#c19bff' }]}>
            <Text style={[styles.pillarBadgeSmText, { color: '#1a0d2a' }]}>S</Text>
          </View>
          <Text style={styles.legendLabel}>Systems — review automation, CRM, follow-up</Text>
        </View>
      </View>

      {phases.map((phase) => {
        const phaseActions = data.actions
          .filter((a) => a.week >= phase.from && a.week <= phase.to)
          .sort((a, b) => a.week - b.week);
        if (phaseActions.length === 0) return null;
        return (
          <View key={phase.title}>
            <View style={styles.phaseHeader}>
              <Text style={styles.phaseTitle}>{phase.title}</Text>
              <Text style={styles.phaseRange}>{phase.range}</Text>
            </View>
            {phaseActions.map((a, i) => {
              const p = priorityStyle(a.priority);
              const pillar = pillarStyle(a.pillar);
              return (
                <View key={i} style={styles.roadmapRow} wrap={false}>
                  <Text style={styles.rmWeek}>W{a.week}</Text>
                  <Text
                    style={[
                      styles.priorityPill,
                      { backgroundColor: p.bg, color: p.fg },
                    ]}
                  >
                    {a.priority}
                  </Text>
                  <Text style={styles.rmAction}>{a.action}</Text>
                  <Text style={styles.rmDifficulty}>{a.difficulty}</Text>
                  <Text style={styles.rmLift}>+{a.projectedScoreLift}</Text>
                  <View style={styles.rmPillarCell}>
                    <View
                      style={[
                        styles.pillarBadgeBox,
                        { backgroundColor: pillar.bg },
                      ]}
                    >
                      <Text style={[styles.pillarBadgeText, { color: pillar.fg }]}>
                        {PILLAR_LABEL[a.pillar]}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        );
      })}

      <View style={styles.llmCallout}>
        <Text>
          All three pillars (V, D, S) are covered under Fourdots
          Digital&apos;s Local Lead Machine — the done-for-you
          implementation. This Roadmap focuses on Visibility (V) —
          what you can execute solo. The Demand and Systems actions
          surfaced here are the bridge into the LLM conversation we
          have on the strategist call.
        </Text>
      </View>

      <Footer />
    </Page>
  );
}

// ─── Page 5: cumulative impact projection ─────────────────────────────

function PageProjection({ data }: { data: RoadmapPdfData }) {
  const startScore = data.currentTurfScore;
  const phase1Lift = phaseSliceLift(data.actions, 1, 4);
  const phase2Lift = phaseSliceLift(data.actions, 5, 8);
  const phase3Lift = phaseSliceLift(data.actions, 9, 12);
  const day30 = startScore + phase1Lift;
  const day60 = day30 + phase2Lift;
  const day90 = day60 + phase3Lift;
  const maxScore = Math.max(100, day90);

  // Bar chart geometry in PDF user units (1pt = 1pt). Container width
  // is (page width 612) - margins (72) = 540pt. Chart inset further
  // by the chartBox padding (16 each side) → 508pt usable.
  const CHART_W = 500;
  const CHART_H = 140;
  const BAR_GAP = 14;
  const BAR_W = (CHART_W - BAR_GAP * 3) / 4;
  const bars = [
    { label: 'NOW', value: startScore, color: C.textMuted },
    { label: '30 DAYS', value: day30, color: C.warn },
    { label: '60 DAYS', value: day60, color: C.warn },
    { label: '90 DAYS', value: day90, color: C.lime },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="CUMULATIVE IMPACT" />

      <Text style={styles.h2}>Cumulative impact projection</Text>

      <View style={styles.chartBox}>
        <Text style={styles.chartLabel}>
          PROJECTED TURFSCORE BY PHASE — START TO 90 DAYS
        </Text>
        <Svg width={CHART_W} height={CHART_H + 24}>
          {/* Y-axis baseline */}
          <Line
            x1={0}
            y1={CHART_H}
            x2={CHART_W}
            y2={CHART_H}
            stroke={C.border}
            strokeWidth={1}
          />
          {bars.map((b, i) => {
            const x = i * (BAR_W + BAR_GAP);
            const h = (b.value / maxScore) * CHART_H;
            return (
              <Rect
                key={i}
                x={x}
                y={CHART_H - h}
                width={BAR_W}
                height={h}
                fill={b.color}
              />
            );
          })}
          {bars.map((b, i) => {
            const x = i * (BAR_W + BAR_GAP) + BAR_W / 2;
            return (
              <Text
                key={`lbl-${i}`}
                x={x}
                y={CHART_H + 12}
                style={{ fontSize: 7 }}
                fill={C.textMuted}
                textAnchor="middle"
              >
                {b.label}
              </Text>
            );
          })}
          {bars.map((b, i) => {
            const x = i * (BAR_W + BAR_GAP) + BAR_W / 2;
            const h = (b.value / maxScore) * CHART_H;
            return (
              <Text
                key={`val-${i}`}
                x={x}
                y={CHART_H - h - 4}
                style={{ fontSize: 9, fontWeight: 700 }}
                fill={C.text}
                textAnchor="middle"
              >
                {b.value}
              </Text>
            );
          })}
        </Svg>
      </View>

      <Text style={styles.h3}>VISIBILITY ALONE ISN&apos;T THE FULL EQUATION</Text>
      <Text style={styles.body}>
        TurfScore lift drives more local-pack appearances. But
        appearances become customers only if your paid traffic is
        targeted, your landing pages convert, and your leads are
        followed up fast. Visibility is one of three pillars in a
        complete demand-generation system.
      </Text>

      <View style={styles.pillarRow}>
        <View style={styles.pillarMiniAccent}>
          <View
            style={[
              styles.pillarMiniDot,
              { backgroundColor: PILLAR_PALETTE.visibility.bg },
            ]}
          />
          <Text style={styles.pillarMiniTitle}>VISIBILITY</Text>
          <Text style={styles.pillarMiniSub}>This audit + roadmap</Text>
        </View>
        <View style={styles.pillarMini}>
          <View
            style={[
              styles.pillarMiniDot,
              { backgroundColor: PILLAR_PALETTE.demand.bg },
            ]}
          />
          <Text style={styles.pillarMiniTitle}>DEMAND</Text>
          <Text style={styles.pillarMiniSub}>
            Google + Meta ads, conversion funnel
          </Text>
        </View>
        <View style={styles.pillarMini}>
          <View
            style={[
              styles.pillarMiniDot,
              { backgroundColor: PILLAR_PALETTE.systems.bg },
            ]}
          />
          <Text style={styles.pillarMiniTitle}>SYSTEMS</Text>
          <Text style={styles.pillarMiniSub}>
            Email follow-up, CRM, attribution
          </Text>
        </View>
      </View>

      <Text style={[styles.bodyTight, { marginTop: 14, fontStyle: 'italic' }]}>
        Operators who execute all three pillars typically see 2–3× revenue
        lift within 90 days, vs. visibility alone.
      </Text>

      <Footer />
    </Page>
  );
}

// ─── Page 6: LLM segue (three-pillar layout) ──────────────────────────

function PageLlmSegue({ data }: { data: RoadmapPdfData }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="DONE-FOR-YOU OPTION" />

      <Text style={styles.h2}>Considering full done-for-you implementation?</Text>
      <Text style={styles.body}>
        Most operators executing this Roadmap solo invest 8–15 hours per
        week for 90+ days. Local Lead Machine is Fourdots Digital&apos;s
        done-for-you alternative — installed in 2 weeks, results in 30
        days.
      </Text>

      <View style={styles.pillar3Row}>
        <View style={styles.pillarBox}>
          <View style={styles.pillarIconRow}>
            <View
              style={[
                styles.pillarSquare,
                { backgroundColor: PILLAR_PALETTE.demand.bg },
              ]}
            />
            <Text style={styles.pillarTitle}>DEMAND</Text>
          </View>
          <Text style={styles.pillarItem}>• Google Ads (search + Performance Max)</Text>
          <Text style={styles.pillarItem}>• Meta Ads (Facebook + Instagram)</Text>
          <Text style={styles.pillarItem}>• High-converting landing funnel</Text>
          <Text style={styles.pillarItem}>• Monthly UGC-style + static creative</Text>
        </View>

        <View style={styles.pillarBoxAccent}>
          <View style={styles.pillarIconRow}>
            <View
              style={[
                styles.pillarSquare,
                { backgroundColor: PILLAR_PALETTE.visibility.bg },
              ]}
            />
            <Text style={styles.pillarTitle}>VISIBILITY</Text>
          </View>
          <Text style={styles.pillarItem}>• Google Business Profile optimization</Text>
          <Text style={styles.pillarItem}>• Top-30 directory NAP consistency</Text>
          <Text style={styles.pillarItem}>• LocalBusiness schema integration</Text>
          <Text style={styles.pillarItem}>• GBP photo asset system</Text>
          <Text style={styles.pillarItem}>• Long-tail local-SEO content</Text>
          <Text style={styles.pillarOurs}>YOUR ROADMAP COVERS THIS PILLAR</Text>
        </View>

        <View style={styles.pillarBox}>
          <View style={styles.pillarIconRow}>
            <View
              style={[
                styles.pillarSquare,
                { backgroundColor: PILLAR_PALETTE.systems.bg },
              ]}
            />
            <Text style={styles.pillarTitle}>SYSTEMS</Text>
          </View>
          <Text style={styles.pillarItem}>• Review velocity (SMS + email post-job)</Text>
          <Text style={styles.pillarItem}>• Automated email follow-up sequences</Text>
          <Text style={styles.pillarItem}>• CRM + lead tracking + attribution</Text>
          <Text style={styles.pillarItem}>• Monthly performance reporting</Text>
          <Text style={styles.pillarItem}>• Cost-per-lead, cost-per-booking, revenue</Text>
        </View>
      </View>

      <View style={styles.qualifyBox}>
        <Text style={styles.qualifyTitle}>QUALIFICATION CHECKLIST</Text>
        {/* Revenue gate ($50K+/month) removed per operator decision —
         *  being phased out of all LLM-positioning touchpoints. */}
        <View style={styles.qualifyRow}>
          <View style={styles.qualifyBox_check} />
          <Text style={styles.qualifyText}>Can commit $3K+/month to ad spend</Text>
        </View>
        <View style={styles.qualifyRow}>
          <View style={styles.qualifyBox_check} />
          <Text style={styles.qualifyText}>Can handle 10–30+ extra jobs/month</Text>
        </View>
        <View style={styles.qualifyRow}>
          <View style={styles.qualifyBox_check} />
          <Text style={styles.qualifyText}>At least one truck or crew available</Text>
        </View>
      </View>

      <Text style={styles.closingBlock}>
        Operators who execute all three pillars typically see 2–3× revenue
        lift within 90 days, vs. visibility alone.
      </Text>
      <Text style={styles.closingBlock}>
        If your operation matches the qualification, we&apos;ll discuss Local
        Lead Machine on your strategist call. We accept 4 operators per
        month — one per trade per metro.
      </Text>
      <Text style={[styles.closingBlock, { fontStyle: 'italic', color: C.textMuted }]}>
        Not LLM-fit? No problem. Your 90-Day Roadmap has everything you
        need to execute solo or with a freelancer.
      </Text>

      <Footer />
    </Page>
  );
}

// ─── Public Document component ────────────────────────────────────────

// ─── Page (optional): Strategy-tier 3-keyword landscape ──────────────
//
// Renders only when keywordLandscape is non-empty (Strategy Session
// tier). Sits between the cover and the TurfGap page so the buyer +
// strategist see the cross-keyword comparison FIRST, before drilling
// into the primary keyword's roadmap details. Audit + scan tiers
// skip this page entirely.

function PageKeywordLandscape({ data }: { data: RoadmapPdfData }) {
  const rows = data.keywordLandscape ?? [];
  if (rows.length === 0) return null;
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="KEYWORD LANDSCAPE" />

      <View style={styles.coverHero}>
        <Text style={styles.coverEyebrow}>
          KEYWORD LANDSCAPE — 3-WAY COMPARISON
        </Text>
        <Text style={styles.coverTitle}>
          Three angles, one territory.
        </Text>
        <Text style={styles.coverSub}>
          We scanned {data.businessName} against three keywords across
          the same 81-point grid. The strategist call is where you
          pick which one to lean into; the Roadmap that follows is
          framed around the primary.
        </Text>
      </View>

      {/* Three heatmaps across the top — eye-level comparative beat.
       *  Each card carries a label + the buyer's TurfScore for that
       *  keyword, with the primary highlighted lime. The 9×9 grid
       *  reads as a visual fingerprint per keyword so the strategist
       *  can point at the differences without explaining the colors. */}
      <View
        style={{
          flexDirection: 'row',
          gap: 10,
          marginTop: 14,
        }}
      >
        {rows.map((row, i) => {
          const isPrimary = i === 0;
          const labelText = isPrimary ? 'PRIMARY' : `ANGLE #${i + 1}`;
          return (
            <View
              key={`hm-${row.keyword}-${i}`}
              style={[
                isPrimary ? styles.scoreCellHi : styles.scoreCell,
                { flex: 1, alignItems: 'center', padding: 10 },
              ]}
            >
              <Text style={styles.scoreLabel}>{labelText}</Text>
              <Text
                style={{
                  fontSize: 10,
                  color: C.text,
                  fontWeight: 700,
                  marginTop: 2,
                  marginBottom: 8,
                  textAlign: 'center',
                  lineHeight: 1.25,
                }}
              >
                &ldquo;{row.keyword}&rdquo;
              </Text>
              {row.cells && row.cells.length > 0 ? (
                <MiniHeatmap cells={row.cells} size={140} />
              ) : (
                <View
                  style={{
                    width: 140,
                    height: 140,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 9, color: C.textMuted }}>
                    Scan data pending
                  </Text>
                </View>
              )}
              <Text
                style={{
                  fontSize: 9,
                  color: C.textMuted,
                  marginTop: 8,
                  letterSpacing: 1,
                }}
              >
                TURFSCORE
              </Text>
              <Text
                style={
                  isPrimary
                    ? { ...styles.scoreValueLime, fontSize: 20, marginTop: 2 }
                    : { ...styles.scoreValue, fontSize: 20, marginTop: 2 }
                }
              >
                {row.turfScore}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Per-keyword detail rows below the heatmap fingerprints. Same
       *  Reach/Rank fact strip + operator note as before. */}
      <View style={{ marginTop: 18, gap: 8 }}>
        {rows.map((row, i) => {
          const isPrimary = i === 0;
          return (
            <View
              key={`${row.keyword}-${i}`}
              style={[
                isPrimary ? styles.scoreCellHi : styles.scoreCell,
                { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 14 },
              ]}
            >
              <View style={{ flex: 1.6 }}>
                <Text style={styles.scoreLabel}>
                  {isPrimary ? 'PRIMARY' : `ANGLE #${i + 1}`}
                </Text>
                <Text
                  style={{
                    fontSize: 13,
                    color: C.text,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  &ldquo;{row.keyword}&rdquo;
                </Text>
                {row.note ? (
                  <Text
                    style={{
                      fontSize: 8,
                      color: C.textMuted,
                      marginTop: 3,
                      lineHeight: 1.35,
                    }}
                  >
                    {row.note}
                  </Text>
                ) : null}
              </View>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.scoreLabel}>TURFSCORE</Text>
                <Text
                  style={isPrimary ? styles.scoreValueLime : styles.scoreValue}
                >
                  {row.turfScore}
                </Text>
              </View>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.scoreLabel}>REACH</Text>
                <Text style={styles.scoreValue}>
                  {row.turfReach != null ? `${Math.round(row.turfReach)}%` : '—'}
                </Text>
              </View>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={styles.scoreLabel}>RANK</Text>
                <Text style={styles.scoreValue}>
                  {row.turfRank != null ? row.turfRank.toFixed(2) : '—'}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <Text
        style={{
          fontSize: 9,
          color: C.textMuted,
          marginTop: 18,
          lineHeight: 1.5,
        }}
      >
        How to read this: the primary keyword is the one the strategist
        call agenda + the 90-day Roadmap on the following pages are
        framed around. The other two are kept here because the
        cross-keyword comparison is itself a strategic input — they
        show where the territory leaks differently per service angle,
        and where the easiest win likely lives.
      </Text>
    </Page>
  );
}

export function RoadmapPdf({ data }: { data: RoadmapPdfData }) {
  const hasLandscape =
    (data.keywordLandscape ?? []).length > 0;
  return (
    <Document
      title={`90-Day Roadmap — ${data.businessName}`}
      author="TurfMap.ai · Fourdots Digital"
    >
      <PageCover data={data} />
      {hasLandscape ? <PageKeywordLandscape data={data} /> : null}
      <PageGap data={data} />
      <PageNap data={data} />
      <PageRoadmap data={data} />
      <PageProjection data={data} />
      <PageLlmSegue data={data} />
    </Document>
  );
}

// Re-export the category map so callers building synthetic fixtures
// can reference labels for nice-to-have hover/log output. Kept local
// to avoid widening the import surface in callers.
export { ACTION_CATEGORY_BY_ID };
