/**
 * Pure-SVG dual-axis trend chart for scan history.
 *
 * Plots TurfScore (0–100 composite, higher-is-better, left axis) and
 * TurfReach (0–100% coverage, higher-is-better, right axis) on a
 * shared time axis. Both lines move UP for "things got better" —
 * intentional: makes the trend readable without the viewer having to
 * remember which axis inverts. No charting library dependency —
 * keeps the bundle small and matches the dashboard aesthetic.
 *
 * Input note: `turfScore` here is the new composite 0–100 stored in
 * scans.turf_score (post-2026-05-02 score redesign). The component
 * renders it directly without conversion. `top3Pct` is the prior
 * field name; callers should now pass turf_reach into it.
 *
 * Data assumption: at least 2 points to draw a line; with 1 point, render
 * an empty-state placeholder.
 */

export type TrendPoint = {
  scanId: string;
  /** ISO timestamp of when the scan completed. */
  completedAt: string;
  /** Composite TurfScore from scans.turf_score (0..100). */
  turfScore: number | null;
  /** TurfReach from scans.turf_reach (0..100%). Field name preserved
   *  as `top3Pct` for backward-compat with the parent page binding. */
  top3Pct: number;
};

export type TrendChartProps = {
  points: TrendPoint[];
  height?: number;
};

/** Padding inside the SVG viewport. Top reserves space for axis labels. */
const PAD = { top: 24, right: 56, bottom: 28, left: 48 };

const COLOR_SCORE = '#c5ff3a'; // lime — TurfScore (0–100, higher is better)
const COLOR_RATE = '#ff9f3a'; // orange — Top3 win rate (higher is better)
const COLOR_AXIS = '#3f3f46';
const COLOR_GRID = '#1f1f23';
const COLOR_LABEL = '#71717a';

export function TrendChart({ points, height = 220 }: TrendChartProps) {
  if (points.length < 2) {
    return <EmptyState height={height} count={points.length} />;
  }

  // Time-sort ascending (oldest left, newest right) so the visual matches
  // intuition even if the parent passed reverse-chronological.
  const sorted = [...points].sort(
    (a, b) =>
      new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
  );

  // Both axes are 0..100 with higher-is-better. TurfScore display value
  // is bounded [0, 95] in practice (95 = #1 in every cell) but we render
  // the full 0..100 axis for symmetry with the win-rate axis.
  const SCORE_MIN = 0;
  const SCORE_MAX = 100;

  const RATE_MIN = 0;
  const RATE_MAX = 100;

  const VIEW_W = 800;
  const VIEW_H = height;
  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = VIEW_H - PAD.top - PAD.bottom;

  const xAt = (i: number): number =>
    sorted.length === 1
      ? PAD.left + innerW / 2
      : PAD.left + (i / (sorted.length - 1)) * innerW;

  // Higher is better → invert so 100 sits at the top. Same shape for both
  // metrics so an upward slope on either line means "things improved."
  // turfScore is already 0–100 composite, no conversion needed.
  const yScore = (s: number | null): number => {
    const v = s ?? SCORE_MIN;
    return (
      PAD.top +
      innerH -
      (innerH * (clamp(v, SCORE_MIN, SCORE_MAX) - SCORE_MIN)) /
        (SCORE_MAX - SCORE_MIN)
    );
  };

  const yRate = (r: number): number =>
    PAD.top +
    innerH -
    (innerH * (clamp(r, RATE_MIN, RATE_MAX) - RATE_MIN)) /
      (RATE_MAX - RATE_MIN);

  const scorePath = sorted
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yScore(p.turfScore)}`)
    .join(' ');

  const ratePath = sorted
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yRate(p.top3Pct)}`)
    .join(' ');

  // Tick marks: 5 evenly spaced for both axes (same scale = visual parity).
  const scoreTicks = [0, 25, 50, 75, 100];
  const rateTicks = [0, 25, 50, 75, 100];

  // Date ticks — 4 evenly distributed labels max, but always include first + last.
  const dateTickIdxs = pickDateTicks(sorted.length, 4);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="w-full"
      role="img"
      aria-label="TurfScore and 3-Pack Win Rate trend"
    >
      {/* horizontal gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
        <line
          key={i}
          x1={PAD.left}
          x2={VIEW_W - PAD.right}
          y1={PAD.top + innerH * f}
          y2={PAD.top + innerH * f}
          stroke={COLOR_GRID}
          strokeWidth={1}
        />
      ))}

      {/* y axes */}
      <line
        x1={PAD.left}
        x2={PAD.left}
        y1={PAD.top}
        y2={PAD.top + innerH}
        stroke={COLOR_AXIS}
        strokeWidth={1}
      />
      <line
        x1={VIEW_W - PAD.right}
        x2={VIEW_W - PAD.right}
        y1={PAD.top}
        y2={PAD.top + innerH}
        stroke={COLOR_AXIS}
        strokeWidth={1}
      />
      {/* x axis */}
      <line
        x1={PAD.left}
        x2={VIEW_W - PAD.right}
        y1={PAD.top + innerH}
        y2={PAD.top + innerH}
        stroke={COLOR_AXIS}
        strokeWidth={1}
      />

      {/* y-axis tick labels — score axis (left). Tick values are display-
       *  scale 0..100 already, so we don't pipe them through yScore (which
       *  expects an AMR input). Position them by inverting the same math. */}
      {scoreTicks.map((s) => (
        <text
          key={`s-${s}`}
          x={PAD.left - 6}
          y={
            PAD.top +
            innerH -
            (innerH * (s - SCORE_MIN)) / (SCORE_MAX - SCORE_MIN)
          }
          fontSize={10}
          fill={COLOR_LABEL}
          textAnchor="end"
          dominantBaseline="middle"
          fontFamily="var(--font-mono), monospace"
        >
          {s}
        </text>
      ))}
      {rateTicks.map((r) => (
        <text
          key={`r-${r}`}
          x={VIEW_W - PAD.right + 6}
          y={yRate(r)}
          fontSize={10}
          fill={COLOR_LABEL}
          textAnchor="start"
          dominantBaseline="middle"
          fontFamily="var(--font-mono), monospace"
        >
          {r}%
        </text>
      ))}

      {/* axis legends — positioned so they don't clip at viewBox edges */}
      <text
        x={PAD.left}
        y={PAD.top - 10}
        fontSize={10}
        fill={COLOR_SCORE}
        textAnchor="start"
        fontFamily="var(--font-mono), monospace"
      >
        TurfScore (0–100, higher is better)
      </text>
      <text
        x={VIEW_W - PAD.right}
        y={PAD.top - 10}
        fontSize={10}
        fill={COLOR_RATE}
        textAnchor="end"
        fontFamily="var(--font-mono), monospace"
      >
        TurfReach % (higher is better)
      </text>

      {/* x-axis date labels */}
      {dateTickIdxs.map((i) => (
        <text
          key={`d-${i}`}
          x={xAt(i)}
          y={PAD.top + innerH + 18}
          fontSize={10}
          fill={COLOR_LABEL}
          textAnchor={
            i === 0 ? 'start' : i === sorted.length - 1 ? 'end' : 'middle'
          }
          fontFamily="var(--font-mono), monospace"
        >
          {formatTickDate(sorted[i].completedAt)}
        </text>
      ))}

      {/* TurfScore line + dots (lime) */}
      <path
        d={scorePath}
        fill="none"
        stroke={COLOR_SCORE}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {sorted.map((p, i) => (
        <circle
          key={`sc-${p.scanId}`}
          cx={xAt(i)}
          cy={yScore(p.turfScore)}
          r={3.5}
          fill={COLOR_SCORE}
        />
      ))}

      {/* Top-3 line + dots (orange, dashed) */}
      <path
        d={ratePath}
        fill="none"
        stroke={COLOR_RATE}
        strokeWidth={2}
        strokeDasharray="4 3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {sorted.map((p, i) => (
        <circle
          key={`rt-${p.scanId}`}
          cx={xAt(i)}
          cy={yRate(p.top3Pct)}
          r={3.5}
          fill={COLOR_RATE}
        />
      ))}
    </svg>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function pickDateTicks(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  // First, last, and 2 evenly-spaced interior points.
  const idxs = new Set<number>([0, n - 1]);
  const interior = max - 2;
  for (let k = 1; k <= interior; k++) {
    idxs.add(Math.round((k * (n - 1)) / (interior + 1)));
  }
  return [...idxs].sort((a, b) => a - b);
}

function formatTickDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function EmptyState({ height, count }: { height: number; count: number }) {
  return (
    <div
      className="rounded-md flex items-center justify-center text-xs text-zinc-500"
      style={{ height, background: 'var(--color-grid-bg)' }}
    >
      {count === 0
        ? 'No scans yet — trend will appear after the first scheduled run.'
        : '1 scan in history — trend will draw after the next scan.'}
    </div>
  );
}
