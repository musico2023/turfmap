/**
 * TurfReport — branded PDF export of a single scan.
 *
 * Renders with @react-pdf/renderer (pure JS, no Chromium dependency). The
 * report shows: branded header, business + scan metadata, the 81-point
 * heatmap (as a vector SVG), the three core metrics, top-3 competitors, and
 * — if present — the AI Coach playbook.
 *
 * v1: single Letter-sized page, dark theme matching the dashboard. We can
 * paginate to multiple pages later if the AI insight grows long.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Svg,
  Circle,
  Line,
  G,
} from '@react-pdf/renderer';

// Color tokens duplicated from globals.css. react-pdf evaluates outside the
// browser, so we can't read CSS custom properties.
const C = {
  bg: '#0a0a0a',
  card: '#0d0d0d',
  cardGlow: '#0f1208',
  border: '#27272a',
  borderBright: '#2d3a14',
  lime: '#c5ff3a',
  rankTop3: '#c5ff3a',
  rankMid: '#e8e54a',
  rankLow: '#ff9f3a',
  rankBad: '#ff4d4d',
  text: '#ededed',
  textDim: '#a1a1aa',
  textMuted: '#71717a',
  textFaint: '#52525b',
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: C.bg,
    color: C.text,
    padding: 32,
    fontSize: 9,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 16,
    borderBottom: `1px solid ${C.border}`,
    marginBottom: 16,
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
  logoX: { color: '#000', fontSize: 14, fontWeight: 700 },
  brandTitle: { fontSize: 16, fontWeight: 700, color: C.text },
  brandSub: { fontSize: 7, color: C.textMuted, letterSpacing: 1.6 },
  headerRight: { fontSize: 8, color: C.textMuted },

  metaRow: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 18,
    paddingBottom: 12,
    borderBottom: `1px solid ${C.border}`,
  },
  metaCell: { flex: 1 },
  metaLabel: {
    fontSize: 6.5,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 3,
  },
  metaValue: { fontSize: 10, color: C.text },

  body: { flexDirection: 'row', gap: 16 },
  heatmapBox: {
    width: 320,
    backgroundColor: C.card,
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    padding: 12,
  },
  heatmapTitle: { fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 4 },
  heatmapSub: { fontSize: 7, color: C.textMuted, marginBottom: 8 },

  rightCol: { flex: 1, gap: 10 },
  metricCard: {
    backgroundColor: C.card,
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    padding: 10,
  },
  metricCardHi: {
    backgroundColor: C.cardGlow,
    borderRadius: 6,
    border: `1px solid ${C.borderBright}`,
    padding: 10,
  },
  metricLabel: {
    fontSize: 6.5,
    color: C.textMuted,
    letterSpacing: 1.4,
    marginBottom: 4,
  },
  metricValue: { fontSize: 22, fontWeight: 700, color: C.text },
  metricValueLime: { fontSize: 22, fontWeight: 700, color: C.lime },
  metricSub: { fontSize: 7, color: C.textMuted, marginTop: 3 },

  compRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    paddingVertical: 3,
    color: C.textDim,
  },
  compName: { flex: 1 },
  compStat: { color: C.textMuted },

  coach: {
    marginTop: 16,
    backgroundColor: C.cardGlow,
    border: `1px solid ${C.borderBright}`,
    borderRadius: 6,
    padding: 12,
  },
  coachTitle: { fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 6 },
  coachDiagnosis: {
    fontSize: 9,
    color: C.text,
    paddingLeft: 8,
    borderLeft: `2px solid ${C.lime}`,
    marginBottom: 10,
  },
  actions: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  actionCard: {
    flex: 1,
    backgroundColor: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: 8,
  },
  actionPriority: {
    fontSize: 6,
    fontWeight: 700,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 2,
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  actionTitle: { fontSize: 8, fontWeight: 700, color: C.text, marginBottom: 3 },
  actionWhy: { fontSize: 7, color: C.textDim, lineHeight: 1.4 },
  impact: {
    fontSize: 8,
    color: C.textDim,
    paddingTop: 6,
    borderTop: `1px solid ${C.border}`,
  },

  footer: {
    position: 'absolute',
    bottom: 24,
    left: 32,
    right: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: C.textFaint,
    paddingTop: 8,
    borderTop: `1px solid ${C.border}`,
  },
});

export type TurfReportData = {
  client: { businessName: string; address: string; industry: string | null };
  keyword: string;
  scan: {
    id: string;
    completedAt: string;
    totalPoints: number;
    failedPoints: number;
    dfsCostCents: number;
  };
  metrics: {
    turfScore: number | null;
    /** Already-converted 0–100 strength (avg rank where present). null
     *  means the business doesn't appear in any cell. */
    packStrength: number | null;
    top3Pct: number;
    radiusMiles: number;
  };
  cells: Array<{ x: number; y: number; rank: number | null }>;
  competitors: Array<{ name: string; amr: number; top3Pct: number }>;
  insight: {
    diagnosis: string;
    actions: Array<{ priority: 'HIGH' | 'MEDIUM' | 'LOW'; action: string; why: string }>;
    projectedImpact: string | null;
  } | null;
};

function rankColor(rank: number | null): string {
  if (rank === null) return C.rankBad;
  if (rank <= 3) return C.rankTop3;
  if (rank <= 10) return C.rankMid;
  if (rank <= 20) return C.rankLow;
  return C.rankBad;
}

function rankLabel(rank: number | null): string {
  return rank === null ? '' : String(rank);
}

const CANVAS = 540;
const CELL = 60;
const CELL_R = 22;

function HeatmapSvg({ cells }: { cells: TurfReportData['cells'] }) {
  return (
    <Svg width="296" height="296" viewBox={`0 0 ${CANVAS} ${CANVAS}`}>
      {/* faint grid background */}
      {[120, 270, 420].map((y) => (
        <Line
          key={`h-${y}`}
          x1={0}
          y1={y}
          x2={CANVAS}
          y2={y}
          stroke={y === 270 ? '#202020' : '#1a1a1a'}
          strokeWidth={y === 270 ? 2 : 1}
        />
      ))}
      {[120, 270, 420].map((x) => (
        <Line
          key={`v-${x}`}
          x1={x}
          y1={0}
          x2={x}
          y2={CANVAS}
          stroke={x === 270 ? '#202020' : '#1a1a1a'}
          strokeWidth={x === 270 ? 2 : 1}
        />
      ))}
      {[60, 120, 180].map((r) => (
        <Circle
          key={r}
          cx={CANVAS / 2}
          cy={CANVAS / 2}
          r={r}
          fill="none"
          stroke="#1f1f1f"
          strokeWidth={1}
        />
      ))}

      {cells.map((c) => {
        const cx = CELL / 2 + c.x * CELL;
        const cy = CELL / 2 + c.y * CELL;
        const color = rankColor(c.rank);
        return (
          <G key={`${c.x}-${c.y}`}>
            <Circle cx={cx} cy={cy} r={CELL_R} fill={color} fillOpacity={0.96} />
            {c.rank !== null && (
              <Text
                x={cx}
                y={cy + 5}
                textAnchor="middle"
                style={{ fontSize: 14, fontWeight: 700 }}
                fill="black"
              >
                {rankLabel(c.rank)}
              </Text>
            )}
          </G>
        );
      })}

      {/* center pin */}
      <Circle cx={CANVAS / 2} cy={CANVAS / 2} r={11} fill="white" stroke="black" strokeWidth={2.5} />
      <Circle cx={CANVAS / 2} cy={CANVAS / 2} r={5} fill="black" />
    </Svg>
  );
}

function priorityColors(p: 'HIGH' | 'MEDIUM' | 'LOW'): { bg: string; fg: string } {
  if (p === 'HIGH') return { bg: C.lime, fg: '#000' };
  if (p === 'MEDIUM') return { bg: C.rankLow, fg: '#000' };
  return { bg: '#3a3a3a', fg: '#999' };
}

export function TurfReport({ data }: { data: TurfReportData }) {
  return (
    <Document
      title={`TurfReport — ${data.client.businessName}`}
      author="TurfMap.ai · Local Lead Machine"
    >
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.logoBox}>
              <Text style={styles.logoX}>+</Text>
            </View>
            <View>
              <Text style={styles.brandTitle}>TurfMap™</Text>
              <Text style={styles.brandSub}>GEO-GRID INTELLIGENCE</Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            <Text>An exclusive feature of Local Lead Machine</Text>
            <Text>{new Date(data.scan.completedAt).toISOString().slice(0, 10)}</Text>
          </View>
        </View>

        {/* Business meta */}
        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>BUSINESS</Text>
            <Text style={styles.metaValue}>{data.client.businessName}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>PIN LOCATION</Text>
            <Text style={styles.metaValue}>{data.client.address}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>TRACKING KEYWORD</Text>
            <Text style={styles.metaValue}>{data.keyword}</Text>
          </View>
        </View>

        {/* Heatmap + Metrics */}
        <View style={styles.body}>
          <View style={styles.heatmapBox}>
            <Text style={styles.heatmapTitle}>Territory Heatmap</Text>
            <Text style={styles.heatmapSub}>
              9×9 grid · 81 search points · 1.6mi radius
            </Text>
            <HeatmapSvg cells={data.cells} />
          </View>

          <View style={styles.rightCol}>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>TURFSCORE</Text>
              <Text style={styles.metricValue}>
                {data.metrics.turfScore === null
                  ? '—'
                  : `${data.metrics.turfScore}`}
              </Text>
              <Text style={styles.metricSub}>0–100 · territory coverage</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>PACK STRENGTH</Text>
              <Text style={styles.metricValue}>
                {data.metrics.packStrength === null
                  ? '—'
                  : `${data.metrics.packStrength}`}
              </Text>
              <Text style={styles.metricSub}>0–100 · rank quality where you appear</Text>
            </View>
            <View style={styles.metricCardHi}>
              <Text style={styles.metricLabel}>3-PACK WIN RATE</Text>
              <Text style={styles.metricValueLime}>{data.metrics.top3Pct}%</Text>
              <Text style={styles.metricSub}>% of 81 cells where you rank in the local 3-pack</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>TURFRADIUS</Text>
              <Text style={styles.metricValue}>
                {data.metrics.radiusMiles.toFixed(1)}mi
              </Text>
              <Text style={styles.metricSub}>Furthest distance from your pin where you reach the 3-pack</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricLabel}>3-PACK COMPETITORS</Text>
              {data.competitors.length === 0 ? (
                <Text style={[styles.metricSub, { marginTop: 4 }]}>
                  No competitor data yet.
                </Text>
              ) : (
                data.competitors.map((c, i) => (
                  <View key={i} style={styles.compRow}>
                    <Text style={styles.compName}>
                      {i + 1}. {c.name.length > 28 ? c.name.slice(0, 26) + '…' : c.name}
                    </Text>
                    <Text style={styles.compStat}>
                      AMR {c.amr.toFixed(1)} · {c.top3Pct}%
                    </Text>
                  </View>
                ))
              )}
            </View>
          </View>
        </View>

        {/* AI Coach insight (if available) */}
        {data.insight && (
          <View style={styles.coach}>
            <Text style={styles.coachTitle}>TurfMap AI Coach Playbook</Text>
            <Text style={styles.coachDiagnosis}>{data.insight.diagnosis}</Text>

            <View style={styles.actions}>
              {data.insight.actions.map((a, i) => {
                const p = priorityColors(a.priority);
                return (
                  <View key={i} style={styles.actionCard}>
                    <Text
                      style={{
                        ...styles.actionPriority,
                        backgroundColor: p.bg,
                        color: p.fg,
                      }}
                    >
                      {a.priority}
                    </Text>
                    <Text style={styles.actionTitle}>{a.action}</Text>
                    <Text style={styles.actionWhy}>{a.why}</Text>
                  </View>
                );
              })}
            </View>

            {data.insight.projectedImpact && (
              <Text style={styles.impact}>
                <Text style={{ color: C.lime }}>PROJECTED IMPACT — </Text>
                {data.insight.projectedImpact}
              </Text>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>© Local Lead Machine · TurfMap™ proprietary technology of Fourdots Digital</Text>
          <Text>
            Scan {data.scan.id.slice(0, 8)} · {data.scan.failedPoints} failed pts · ${(data.scan.dfsCostCents / 100).toFixed(2)} DFS
          </Text>
        </View>
      </Page>
    </Document>
  );
}
