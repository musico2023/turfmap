'use client';

import { useEffect, useRef, useState } from 'react';
import { HeatmapGrid, type HeatmapCell } from '@/components/turfmap/HeatmapGrid';

/**
 * In-view animator for HeatmapGrid.
 *
 * Wraps HeatmapGrid in an IntersectionObserver so the cell-by-cell
 * reveal animation only fires when the grid actually enters the
 * buyer's viewport — not on mount. Critical on /scan where the grid
 * sits below the hero: a mount-time animation would burn off before
 * the buyer ever scrolls to it, leaving them with a static end-state
 * "screenshot" instead of the "live software" demo the brief calls for.
 *
 * Behavior:
 *   - Render the grid in its STATIC end state until the wrapper crosses
 *     the intersection threshold (0.3 by default — most of the grid
 *     needs to be visible before the animation kicks off).
 *   - On first intersection, flip animateReveal to true. HeatmapGrid's
 *     internal effect re-runs and the cell-by-cell reveal plays.
 *   - Once played, never replay — the animation is a first-impression
 *     moment; replaying on scroll-back would feel jittery.
 *   - prefers-reduced-motion is honored inside HeatmapGrid itself; this
 *     wrapper passes the prop through, the grid no-ops to the static
 *     end state if the OS-level motion setting is reduce.
 */

export type HeatmapAnimateOnViewProps = {
  cells: HeatmapCell[];
  /** Threshold (0..1) of intersection ratio required to fire the
   *  animation. Default 0.3 — most of the grid must be on-screen so the
   *  animation isn't half-finished when the buyer scrolls to it. */
  threshold?: number;
  /** Direction the reveal travels. See HeatmapGrid.revealOrder. */
  revealOrder?: 'center-out' | 'outside-in';
  /** Delay per distance unit (ms). See HeatmapGrid.revealMsPerDist. */
  revealMsPerDist?: number;
};

export function HeatmapAnimateOnView({
  cells,
  threshold = 0.3,
  revealOrder = 'outside-in',
  revealMsPerDist = 200,
}: HeatmapAnimateOnViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [animate, setAnimate] = useState(false);
  // Sticky flag: once the animation has played, don't replay on
  // scroll-back.
  const playedRef = useRef(false);

  useEffect(() => {
    if (playedRef.current) return;
    const el = wrapperRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          !playedRef.current &&
          entry.isIntersecting &&
          entry.intersectionRatio >= threshold
        ) {
          playedRef.current = true;
          setAnimate(true);
          observer.disconnect();
        }
      },
      { threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return (
    <div ref={wrapperRef}>
      <HeatmapGrid
        cells={cells}
        animateReveal={animate}
        revealOrder={revealOrder}
        revealMsPerDist={revealMsPerDist}
      />
    </div>
  );
}
