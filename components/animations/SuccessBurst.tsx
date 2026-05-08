'use client';

import { useEffect, useState } from 'react';

/**
 * One-shot CSS-only sparkle burst — fires from the center of its
 * parent container. Particles fan out radially over ~1.4s then
 * unmount themselves. Used to mark the celebratory beats of the
 * post-checkout flow:
 *
 *   - One-time success card (scan delivered)
 *   - OnboardingWizard's done step
 *   - Pulse trial activation banner (compact variant)
 *
 * Why CSS-only and not canvas-confetti / lottie:
 *   - No deps, no script tag, no SSR hydration drift.
 *   - Tasteful default. Confetti libraries default to gaudy
 *     multicolor bursts that read as celebratory app onboarding;
 *     TurfMap is operator-tooling, not party software. A small
 *     lime + zinc particle fan reads as "operationally meaningful
 *     completion" rather than "you got a coupon!".
 *   - Respects prefers-reduced-motion via the global CSS gate
 *     (animate-sparkle becomes animation: none).
 *
 * Render this *inside* a relatively-positioned ancestor — the burst
 * uses position:absolute and assumes the parent owns the coordinate
 * space.
 */
export type SuccessBurstProps = {
  /** When true, mount the particles. Set true once on the parent's
   *  success-state mount; the component handles its own auto-
   *  unmount after the animation lifetime so the parent can leave
   *  this true forever. */
  active: boolean;
  /** Optional override for the burst character. Defaults to a
   *  18-particle lime + zinc fan suitable for medium card surfaces.
   *  Pass 'compact' to halve the count for inline banner mounts
   *  where a full burst would feel overstated. */
  variant?: 'default' | 'compact';
};

/** Per-particle render-time config — angle in degrees, fan distance
 *  in pixels, animation duration in ms, color hex, and size in px.
 *  Distances + durations are randomized within bands so the fan
 *  reads as organic rather than algorithmic. */
type Particle = {
  angle: number;
  distance: number;
  duration: number;
  color: string;
  size: number;
  delay: number;
};

const LIME = '#c5ff3a';
const ZINC = '#e4e4e7';

function generateParticles(count: number): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    // Even angular distribution + small jitter so the fan covers
    // the full 360° without gaps but doesn't read as a clock.
    const baseAngle = (360 / count) * i;
    const jitter = (Math.random() - 0.5) * (360 / count) * 0.6;
    particles.push({
      angle: baseAngle + jitter,
      distance: 80 + Math.random() * 60, // 80-140px
      duration: 1100 + Math.random() * 500, // 1100-1600ms
      // ~70% lime, ~30% zinc — lime dominates so the burst reads
      // as branded; zinc particles add visual variety.
      color: Math.random() > 0.3 ? LIME : ZINC,
      size: 4 + Math.random() * 4, // 4-8px
      delay: Math.random() * 100, // 0-100ms stagger
    });
  }
  return particles;
}

const PARTICLE_COUNT = { default: 18, compact: 10 };
const TOTAL_LIFETIME_MS = 2000; // longer than max duration so fade completes

export function SuccessBurst({ active, variant = 'default' }: SuccessBurstProps) {
  const [particles, setParticles] = useState<Particle[] | null>(null);

  useEffect(() => {
    if (!active) return;
    setParticles(generateParticles(PARTICLE_COUNT[variant]));
    const t = setTimeout(() => setParticles(null), TOTAL_LIFETIME_MS);
    return () => clearTimeout(t);
  }, [active, variant]);

  if (!particles) return null;

  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none overflow-visible"
      style={{ zIndex: 1 }}
    >
      {particles.map((p, i) => (
        <span
          key={i}
          className="absolute animate-sparkle"
          style={
            {
              top: '50%',
              left: '50%',
              width: `${p.size}px`,
              height: `${p.size}px`,
              borderRadius: '999px',
              background: p.color,
              boxShadow:
                p.color === LIME
                  ? `0 0 ${p.size * 2}px ${LIME}`
                  : `0 0 ${p.size}px ${ZINC}80`,
              // Custom properties consumed by the sparkle-burst
              // keyframe (defined in globals.css). React typing
              // doesn't know about CSS vars on style; cast through.
              '--angle': `${p.angle}deg`,
              '--distance': `-${p.distance}px`,
              '--duration': `${p.duration}ms`,
              animationDelay: `${p.delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
