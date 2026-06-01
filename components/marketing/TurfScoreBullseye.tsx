/**
 * TurfScoreBullseye — concentric-rings visualization of the TurfScore
 * band spectrum, paired with a labeled legend.
 *
 * Used on the homepage section 02 (the problem section) to anchor
 * the abstract "you'll get a score" concept with a literal target:
 * the bullseye in the center is where the buyer wants to land (Rare
 * air, 80-100); the outer ring is where most pre-optimization buyers
 * actually are (Invisible, 0-20). The ring colors match the live
 * product's heatmap palette (lib/metrics/turfScoreBands) so the
 * gradient the buyer sees here is the same one their real scan
 * will use.
 *
 * The crosshair icon at the center reinforces the TurfMap brand
 * mark visually — it's the same shape as the lime square in the
 * site nav + the favicon.
 *
 * Layout: bullseye SVG on the left, legend list on the right at
 * desktop widths; stacks (bullseye on top, legend below) on mobile.
 * Component is self-contained — drop it in anywhere a TurfScore
 * primer is useful.
 */

import { Crosshair } from 'lucide-react';

// Band definitions — kept in sync with lib/metrics/turfScoreBands +
// components/marketing/TurfScoreShowcase. Order is OUTER → INNER
// so the bullseye reads as: "you start on the outside (invisible),
// you aim for the center (rare air)."
type Band = {
  /** Tier label shown in the legend. */
  label: string;
  /** Score range shown in mono next to the label. */
  range: string;
  /** Hex color for the ring fill + the legend swatch. */
  color: string;
  /** One-line caption explaining what landing here means. */
  caption: string;
};

const BANDS: Band[] = [
  {
    label: 'Invisible',
    range: '0–20',
    color: '#ff4d4d',
    caption: "You don't show up. Customers find someone else.",
  },
  {
    label: 'Patchy',
    range: '20–40',
    color: '#ff9f3a',
    caption: 'Visible in pockets, invisible in most of your area.',
  },
  {
    label: 'Solid',
    range: '40–60',
    color: '#e8e54a',
    caption: 'Decent reach, but rarely at the top of the pack.',
  },
  {
    label: 'Dominant',
    range: '60–80',
    color: '#c5ff3a',
    caption: "Top pack in most cells. You're the call.",
  },
  {
    label: 'Rare air',
    range: '80+',
    color: '#f5c842',
    caption: 'Saturated — #1 across your whole territory.',
  },
];

// SVG geometry. 200×200 viewBox; each ring shrinks the radius by 20.
// Center crosshair sits in the innermost 40-unit disc.
const VIEWBOX = 200;
const CENTER = VIEWBOX / 2;
// Outermost radius. Subsequent rings step down by RING_STEP.
const OUTER_R = 95;
const RING_STEP = 18;

export function TurfScoreBullseye() {
  // Render rings outer-to-inner so SVG stacks larger circles below
  // smaller ones. The BANDS array is ordered outer-to-inner already.
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-6 md:gap-8 items-center">
      {/* Bullseye — 2/5 of the grid on desktop. The container's
       *  aspect-square keeps the SVG perfectly round at any width. */}
      <div className="md:col-span-2 flex justify-center">
        <div className="relative w-full max-w-[260px] aspect-square">
          <svg
            viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
            className="w-full h-full"
            role="img"
            aria-label="TurfScore band gradient — outer rings represent low scores (invisible), the center represents a perfect score"
          >
            {/* Outer-to-inner ring stack. Each circle is fully
             *  filled (not stroked) so the next inner ring
             *  effectively cuts a hole by sitting on top of it. */}
            {BANDS.map((band, i) => (
              <circle
                key={band.label}
                cx={CENTER}
                cy={CENTER}
                r={OUTER_R - i * RING_STEP}
                fill={band.color}
                opacity={0.92}
              />
            ))}
            {/* Subtle outer glow ring to lift the whole shape off
             *  the dark page surface. */}
            <circle
              cx={CENTER}
              cy={CENTER}
              r={OUTER_R + 1}
              fill="none"
              stroke="#c5ff3a"
              strokeOpacity={0.18}
              strokeWidth={1.5}
            />
          </svg>
          {/* Crosshair logo at exact center, absolutely positioned over
           *  the SVG. Lime square + black icon — matches the nav mark. */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            aria-hidden
          >
            <div
              className="w-10 h-10 md:w-12 md:h-12 rounded-md flex items-center justify-center"
              style={{
                background: 'var(--color-lime)',
                boxShadow:
                  '0 0 24px #c5ff3a55, 0 4px 14px rgba(0,0,0,0.4)',
              }}
            >
              <Crosshair
                size={22}
                strokeWidth={2.5}
                className="text-black"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Legend — 3/5 of the grid on desktop. Each band gets a row
       *  with: color swatch, range (mono), name (bold), one-line
       *  caption. Reads top-down high-to-low so the buyer's eye
       *  scans from "where you want to be" downward to "where you
       *  probably are now." */}
      <div className="md:col-span-3">
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500 mb-3">
          The TurfScore scale
        </div>
        <ul className="space-y-2.5">
          {/* Render in REVERSE order so the legend reads
           *  high-score-first (the buyer sees Rare air at top —
           *  the aspirational state) while the bullseye still
           *  renders outer-to-inner low-to-high. */}
          {BANDS.slice().reverse().map((band) => (
            <li
              key={band.label}
              className="flex items-start gap-3 text-sm leading-tight"
            >
              <span
                className="flex-shrink-0 w-3.5 h-3.5 rounded-sm mt-1"
                style={{
                  background: band.color,
                  boxShadow: `0 0 8px ${band.color}55`,
                }}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span
                    className="font-display font-bold text-zinc-100"
                    style={{ color: band.color }}
                  >
                    {band.label}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-500">
                    {band.range}
                  </span>
                </div>
                <div className="text-xs text-zinc-400 leading-relaxed mt-0.5">
                  {band.caption}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-4 italic">
          Most local businesses we scan land{' '}
          <span className="text-zinc-300 font-semibold not-italic">
            between 30 and 55
          </span>{' '}
          before optimization.
        </p>
      </div>
    </div>
  );
}
