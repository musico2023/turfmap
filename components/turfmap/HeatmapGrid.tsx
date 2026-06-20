'use client';

import { useEffect, useState } from 'react';
import { Crosshair } from 'lucide-react';

const BRAND_LIME = '#c5ff3a';
const GRID_SIZE = 9;
const CELL_PIXELS = 60;
const CANVAS = GRID_SIZE * CELL_PIXELS; // 540

export type HeatmapCell = {
  x: number;
  y: number;
  /** null = not in the local 3-pack */
  rank: number | null;
};

export type HeatmapGridProps = {
  cells: HeatmapCell[];
  /** When true, cells fade in on mount with a distance-staggered
   *  delay. Use HeatmapAnimateOnView wrapper to defer the animation
   *  until the grid is actually scrolled into view (e.g. on the /scan
   *  cold-Meta lander where the grid sits below the hero). */
  animateReveal?: boolean;
  /**
   * Direction the reveal animation travels.
   *
   *   - 'center-out' (default): cells closest to the center pin appear
   *     first, corners last. The classic "scan radiates outward" look —
   *     used on /yourmap, /freescan, /fourdots, and the live operator
   *     dashboard.
   *   - 'outside-in': corners and edges appear first, center last. Used
   *     on the cold-Meta /scan lander where the goal is "live software
   *     converging on your business" — closes on the center pin for a
   *     stronger CTA-handoff moment.
   */
  revealOrder?: 'center-out' | 'outside-in';
  /**
   * Milliseconds of delay added per unit of distance from the center.
   * Lower values (≤ ~80) snap the animation through quickly (~700ms total
   * across the 9x9 grid); higher values stretch it for landing pages
   * where the animation IS the demo. /scan uses ~200 to land near the
   * brief-specified 1.8s total.
   */
  revealMsPerDist?: number;
};

// Cell colors must match the legend rendered above the heatmap on the
// dashboard (#1 lime / #2 yellow / #3 orange / not-in-pack red). The
// previous implementation collapsed all 3-pack ranks to lime, which made
// every cell look identical and broke the legend's visual contract.
function rankColor(rank: number | null): string {
  if (rank === null) return '#ff4d4d'; // not in 3-pack → red
  if (rank === 1) return BRAND_LIME; // #1 → lime
  if (rank === 2) return '#e8e54a'; // #2 → yellow
  if (rank === 3) return '#ff9f3a'; // #3 → orange
  // Out-of-pack ranks (4+) shouldn't normally show up in the 9×9 grid
  // — DataForSEO Local Pack returns ranks 1-3 + "not present". Treat
  // anything else as not-in-pack for consistency with the legend.
  return '#ff4d4d';
}

/**
 * Display label for the cell. Null rank shows as "—" (not in 3-pack).
 */
function rankLabel(rank: number | null): string {
  return rank === null ? '—' : String(rank);
}

/**
 * Squared distance from grid center, used to order the reveal animation.
 */
function distFromCenter(x: number, y: number): number {
  const c = (GRID_SIZE - 1) / 2;
  return Math.sqrt((x - c) ** 2 + (y - c) ** 2);
}

export function HeatmapGrid({
  cells,
  animateReveal = true,
  revealOrder = 'center-out',
  revealMsPerDist = 80,
}: HeatmapGridProps) {
  // Honor prefers-reduced-motion at runtime — buyers who've opted out
  // of OS-level animation get the static end state immediately. Lives
  // in state because the media query can change mid-session.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only effect (mount/hydration guard, timer, or external-store sync) — not derivable during render
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const effectiveAnimate = animateReveal && !reducedMotion;

  const [revealedAt, setRevealedAt] = useState<number>(
    effectiveAnimate ? 0 : Infinity
  );

  useEffect(() => {
    if (!effectiveAnimate) {
      // Snap to the fully-revealed end state when animation is
      // disabled (incl. reduced-motion toggled on mid-session).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only effect (mount/hydration guard, timer, or external-store sync) — not derivable during render
      setRevealedAt(Infinity);
      return;
    }
    setRevealedAt(0);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      setRevealedAt(now - start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [effectiveAnimate]);

  // Pre-compute the geometric max distance for outside-in inversion.
  // For a 9x9 grid, MAX_DIST = sqrt(2*4^2) ≈ 5.657. Cached out of the
  // cell loop since it's the same for every cell on every render.
  const MAX_DIST = Math.sqrt(2 * Math.pow((GRID_SIZE - 1) / 2, 2));

  return (
    <div
      // grid-bg paints the faint 60px scope-readout lime grid via two
      // stacked linear-gradients (see globals.css). MUST use
      // `backgroundColor` here, not the `background` shorthand — the
      // shorthand resets background-image and the grid disappears.
      className="relative aspect-square w-full max-w-2xl mx-auto rounded-md overflow-hidden grid-bg"
      style={{ backgroundColor: 'var(--color-grid-bg)' }}
    >
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
      >
        <defs>
          <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={BRAND_LIME} stopOpacity="0.18" />
            <stop offset="100%" stopColor={BRAND_LIME} stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={CANVAS / 2} cy={CANVAS / 2} r="220" fill="url(#centerGlow)" />

        {/* Stylized streets */}
        {[120, 270, 420].map((y) => (
          <line
            key={`h-${y}`}
            x1="0"
            y1={y}
            x2={CANVAS}
            y2={y}
            stroke={y === 270 ? '#202020' : '#1a1a1a'}
            strokeWidth={y === 270 ? '2' : '1.5'}
          />
        ))}
        {[120, 270, 420].map((x) => (
          <line
            key={`v-${x}`}
            x1={x}
            y1="0"
            x2={x}
            y2={CANVAS}
            stroke={x === 270 ? '#202020' : '#1a1a1a'}
            strokeWidth={x === 270 ? '2' : '1.5'}
          />
        ))}

        {/* Concentric range rings */}
        {[60, 120, 180].map((r) => (
          <circle
            key={r}
            cx={CANVAS / 2}
            cy={CANVAS / 2}
            r={r}
            fill="none"
            stroke="#1f1f1f"
            strokeWidth="1"
            strokeDasharray="2 4"
          />
        ))}

        {/* Grid points */}
        {cells.map((cell) => {
          const dist = distFromCenter(cell.x, cell.y);
          // Direction-aware delay: outside-in inverts distance so the
          // farthest cells reveal first (corners → center). The product
          // is in `revealMs` units, scaled by revealMsPerDist so the
          // caller controls total animation length.
          const orderedDist =
            revealOrder === 'outside-in' ? MAX_DIST - dist : dist;
          const revealMs = effectiveAnimate ? orderedDist * revealMsPerDist : 0;
          const isRevealed = revealedAt >= revealMs;
          const cx = CELL_PIXELS / 2 + cell.x * CELL_PIXELS;
          const cy = CELL_PIXELS / 2 + cell.y * CELL_PIXELS;
          const color = rankColor(cell.rank);
          return (
            <g
              key={`${cell.x}-${cell.y}`}
              style={{
                opacity: isRevealed ? 1 : 0,
                transition: 'opacity 220ms ease-out',
              }}
            >
              <circle
                cx={cx}
                cy={cy}
                r={isRevealed ? 23 : 0}
                fill={color}
                opacity="0.96"
                style={{ transition: 'r 280ms cubic-bezier(0.2, 1.6, 0.4, 1)' }}
              />
              <circle
                cx={cx}
                cy={cy}
                r={isRevealed ? 23 : 0}
                fill="none"
                stroke={color}
                strokeWidth="1"
                opacity="0.4"
                style={{ transition: 'r 280ms cubic-bezier(0.2, 1.6, 0.4, 1)' }}
              />
              {isRevealed && (
                <text
                  x={cx}
                  y={cy + 5}
                  textAnchor="middle"
                  fontFamily="var(--font-mono), monospace"
                  fontSize="14"
                  fontWeight="700"
                  fill="black"
                >
                  {rankLabel(cell.rank)}
                </text>
              )}
            </g>
          );
        })}

        {/* Center pin */}
        <g>
          <circle
            cx={CANVAS / 2}
            cy={CANVAS / 2}
            r="16"
            fill="white"
            className="animate-pulse-ring"
            opacity="0.4"
          />
          <circle
            cx={CANVAS / 2}
            cy={CANVAS / 2}
            r="11"
            fill="white"
            stroke="black"
            strokeWidth="2.5"
          />
          <circle cx={CANVAS / 2} cy={CANVAS / 2} r="5" fill="black" />
        </g>
      </svg>

      {cells.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-5 border border-zinc-800"
            style={{ background: '#0a0a0a' }}
          >
            <Crosshair size={28} className="text-zinc-600" strokeWidth={1.5} />
          </div>
          <h4 className="font-display text-xl font-semibold text-zinc-300">
            No scans yet for this client
          </h4>
          <p className="text-sm text-zinc-600 mt-2 max-w-sm">
            Trigger a TurfScan to see the 81-point heatmap render here.
          </p>
        </div>
      )}
    </div>
  );
}
