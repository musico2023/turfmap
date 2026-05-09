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
} from '@react-pdf/renderer';
import { ACTION_CATEGORY_BY_ID } from '@/lib/audit/actionCategories';
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
    fontFamily: 'Helvetica',
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
  logoBox: {
    width: 22,
    height: 22,
    backgroundColor: C.lime,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoSymbol: { color: '#000', fontSize: 14, fontWeight: 700 },
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
  coverHero: { marginTop: 24, marginBottom: 20 },
  coverEyebrow: {
    fontSize: 8,
    color: C.lime,
    letterSpacing: 2,
    marginBottom: 6,
    fontWeight: 700,
  },
  coverTitle: {
    fontSize: 28,
    fontWeight: 700,
    color: C.text,
    lineHeight: 1.05,
    marginBottom: 10,
  },
  coverSub: {
    fontSize: 11,
    color: C.textDim,
    lineHeight: 1.5,
    marginBottom: 4,
  },

  scoreRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    marginBottom: 18,
  },
  scoreCell: {
    flex: 1,
    backgroundColor: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 12,
  },
  scoreCellHi: {
    flex: 1,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 12,
  },
  scoreLabel: {
    fontSize: 7,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  scoreValue: { fontSize: 28, color: C.text, fontWeight: 700, lineHeight: 1 },
  scoreValueLime: {
    fontSize: 28,
    color: C.lime,
    fontWeight: 700,
    lineHeight: 1,
  },
  scoreSub: { fontSize: 8, color: C.textMuted, marginTop: 4 },

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
    padding: 10,
    marginBottom: 6,
    alignItems: 'center',
  },
  competitorRank: {
    fontSize: 18,
    color: C.textMuted,
    fontWeight: 700,
    width: 28,
  },
  competitorName: { fontSize: 11, color: C.text, fontWeight: 700, flex: 1 },
  competitorScore: { fontSize: 14, color: C.lime, fontWeight: 700, marginLeft: 8 },

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
    paddingVertical: 2,
    borderRadius: 3,
    marginRight: 8,
    width: 56,
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
  rmLlmTag: {
    width: 18,
    fontSize: 8,
    textAlign: 'center',
    paddingTop: 1,
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
  pillarMiniIcon: { fontSize: 16, marginBottom: 4 },
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
    gap: 6,
    marginBottom: 8,
  },
  pillarIcon: { fontSize: 14 },
  pillarTitle: { fontSize: 11, color: C.text, fontWeight: 700 },
  pillarItem: {
    fontSize: 7.5,
    color: C.textDim,
    lineHeight: 1.5,
    marginBottom: 3,
  },
  pillarOurs: {
    fontSize: 7,
    color: C.lime,
    fontWeight: 700,
    marginTop: 6,
    fontStyle: 'italic',
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
  difficulty: DifficultyRating;
  priority: ActionPriority;
  projectedScoreLift: number;
  llmCovered: boolean;
};

export type RoadmapPdfNapFinding = {
  /** Status pill text, e.g., "MISSING", "INCONSISTENT", "LIVE". */
  status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
  /** Free-text body, e.g., "Yelp — phone differs from GBP". */
  text: string;
};

export type RoadmapPdfCompetitor = {
  name: string;
  turfScore: number;
  /** Optional short differential blurb, e.g., "380 reviews vs. your 218". */
  differential?: string;
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
  /** Sums computed by the AI generator. The phase totals (4w / 8w /
   *  12w) drive the bar chart on page 5; we recompute here from
   *  actions[] to stay decoupled from the upstream sum logic. */
  ninetyDayTargetLift: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────

function priorityStyle(p: ActionPriority): { bg: string; fg: string } {
  if (p === 'HIGH') return { bg: C.lime, fg: '#000' };
  if (p === 'MEDIUM') return { bg: C.warn, fg: '#000' };
  return { bg: '#3a3a3a', fg: '#999' };
}

function napStatusStyle(s: RoadmapPdfNapFinding['status']): {
  bg: string;
  fg: string;
} {
  if (s === 'LIVE') return { bg: '#1a3a14', fg: C.lime };
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
        <View style={styles.logoBox}>
          <Text style={styles.logoSymbol}>+</Text>
        </View>
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

// ─── Page 1: cover + snapshot ─────────────────────────────────────────

function PageCover({ data }: { data: RoadmapPdfData }) {
  const lift = data.projectedTurfScore - data.currentTurfScore;
  return (
    <Page size="LETTER" style={styles.page}>
      <Header data={data} pageLabel="COVER" />

      <View style={styles.coverHero}>
        <Text style={styles.coverEyebrow}>VISIBILITY AUDIT — 90-DAY ROADMAP</Text>
        <Text style={styles.coverTitle}>
          Where you win. Where you don&apos;t. What to do next.
        </Text>
        <Text style={styles.coverSub}>
          {data.businessName} — {data.trade} in {data.market}
        </Text>
        <Text style={styles.coverSub}>
          81-point geo-grid scan, completed {data.auditDate}.
        </Text>
      </View>

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

      <View style={styles.promiseBox}>
        <Text style={styles.promiseLabel}>TURFSCORE LIFT PROMISE</Text>
        <Text style={styles.promiseText}>
          We&apos;re projecting a {lift}-point lift to {data.projectedTurfScore} in
          30 days based on this Roadmap. Minimum 10-point lift in 30
          days, or we redo the analysis at no charge.
        </Text>
      </View>

      <Text style={[styles.bodyTight, { marginTop: 18, color: C.textMuted }]}>
        This document distills your 81-point geo-grid scan, NAP audit
        findings, and competitive context into a 12-week execution
        plan. Each action carries a projected lift; complete weeks
        1–4 to hit the 30-day target.
      </Text>

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
          <View key={i} style={styles.competitorRow}>
            <Text style={styles.competitorRank}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.competitorName}>{c.name}</Text>
              {c.differential ? (
                <Text style={[styles.bodyTight, { marginTop: 2 }]}>
                  {c.differential}
                </Text>
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
            return (
              <View key={i} style={styles.napFinding}>
                <Text
                  style={[
                    styles.napStatusPill,
                    { backgroundColor: s.bg, color: s.fg },
                  ]}
                >
                  {f.status}
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
      <Text style={[styles.bodyTight, { marginBottom: 6 }]}>
        Each row carries a projected TurfScore lift in points. Tagged
        actions (📍) are part of Fourdots Digital&apos;s Local Lead Machine —
        done-for-you implementation discussed on the strategist call.
      </Text>

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
                  <Text style={styles.rmLlmTag}>{a.llmCovered ? '📍' : ''}</Text>
                </View>
              );
            })}
          </View>
        );
      })}

      <View style={styles.llmCallout}>
        <Text>
          Tagged actions (📍) are part of Fourdots Digital&apos;s Local Lead
          Machine — done-for-you implementation that includes
          visibility, demand generation, and lead-capture systems.
          We&apos;ll discuss whether your operation is a fit on the
          strategist call.
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
          PROJECTED TURFSCORE BY PHASE — START → 90 DAYS
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
        <View style={styles.pillarMini}>
          <Text style={styles.pillarMiniIcon}>📍</Text>
          <Text style={styles.pillarMiniTitle}>VISIBILITY</Text>
          <Text style={styles.pillarMiniSub}>This audit + roadmap</Text>
        </View>
        <View style={styles.pillarMini}>
          <Text style={styles.pillarMiniIcon}>🎯</Text>
          <Text style={styles.pillarMiniTitle}>DEMAND</Text>
          <Text style={styles.pillarMiniSub}>
            Google + Meta ads, conversion funnel
          </Text>
        </View>
        <View style={styles.pillarMini}>
          <Text style={styles.pillarMiniIcon}>⚙️</Text>
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
            <Text style={styles.pillarIcon}>🎯</Text>
            <Text style={styles.pillarTitle}>DEMAND</Text>
          </View>
          <Text style={styles.pillarItem}>• Google Ads (search + Performance Max)</Text>
          <Text style={styles.pillarItem}>• Meta Ads (Facebook + Instagram)</Text>
          <Text style={styles.pillarItem}>• High-converting landing funnel</Text>
          <Text style={styles.pillarItem}>• Monthly UGC-style + static creative</Text>
        </View>

        <View style={styles.pillarBoxAccent}>
          <View style={styles.pillarIconRow}>
            <Text style={styles.pillarIcon}>📍</Text>
            <Text style={styles.pillarTitle}>VISIBILITY</Text>
          </View>
          <Text style={styles.pillarItem}>• Google Business Profile optimization</Text>
          <Text style={styles.pillarItem}>• Review velocity (SMS + email post-job)</Text>
          <Text style={styles.pillarItem}>• Top-30 directory NAP consistency</Text>
          <Text style={styles.pillarItem}>• LocalBusiness schema integration</Text>
          <Text style={styles.pillarItem}>• GBP photo asset system</Text>
          <Text style={styles.pillarOurs}>← Your Roadmap covers this pillar.</Text>
        </View>

        <View style={styles.pillarBox}>
          <View style={styles.pillarIconRow}>
            <Text style={styles.pillarIcon}>⚙️</Text>
            <Text style={styles.pillarTitle}>SYSTEMS</Text>
          </View>
          <Text style={styles.pillarItem}>• Automated email follow-up sequences</Text>
          <Text style={styles.pillarItem}>• CRM + lead tracking + attribution</Text>
          <Text style={styles.pillarItem}>• Monthly performance reporting</Text>
          <Text style={styles.pillarItem}>• Cost-per-lead, cost-per-booking, revenue</Text>
        </View>
      </View>

      <View style={styles.qualifyBox}>
        <Text style={styles.qualifyTitle}>QUALIFICATION CHECKLIST</Text>
        <View style={styles.qualifyRow}>
          <View style={styles.qualifyBox_check} />
          <Text style={styles.qualifyText}>Currently $50K+/month in revenue</Text>
        </View>
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

export function RoadmapPdf({ data }: { data: RoadmapPdfData }) {
  return (
    <Document
      title={`90-Day Roadmap — ${data.businessName}`}
      author="TurfMap.ai · Fourdots Digital"
    >
      <PageCover data={data} />
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
