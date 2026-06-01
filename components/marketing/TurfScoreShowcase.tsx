'use client';

/**
 * TurfScoreShowcase — stylized hero visual for /score.
 *
 * Anchors the abstract "0-100 score" concept BEFORE the buyer fills
 * the form. Two stacked panels:
 *
 *   1. Big lime placeholder score card. The numerals stay at "??"
 *      (we don't fake a specific value — that would erode trust).
 *      An animated lime pulse + "yours appears in 60 seconds" caption
 *      keeps the panel feeling alive while the buyer reads it.
 *
 *   2. Band spectrum — five color-coded tiles spanning 0→100, each
 *      labeled with its band ("Invisible / Patchy / Solid / Dominant /
 *      Rare air"). The band colors match the live product
 *      (lib/metrics/turfScoreBands), so the buyer's eventual score
 *      visually lands on the same gradient they're looking at now.
 *
 * Why both:
 *   The score card alone is abstract ("?? out of 100, so what").
 *   The band spectrum alone is dry ("five colored boxes, so what").
 *   Together they read as "this is the artifact you're getting, and
 *   this is the scale it lives on." The buyer can visualize their
 *   own score landing somewhere on the gradient before they even
 *   submit the form.
 *
 * Reusable: lives in components/marketing/ so future surfaces
 * (homepage hero variant, paid lander A/B test) can drop it in.
 */

import { Target } from 'lucide-react';

// Band tile color tokens — kept in sync with lib/metrics/turfScoreBands
// + the in-app StatCard band rendering. Pulled into a local const
// rather than imported so this component is server-render friendly
// (the band registry is fine in a server context too, but the
// 'use client' here means we don't depend on its module shape).
const BAND_TILES = [
  { range: '0–20', label: 'Invisible', color: '#ff4d4d' },
  { range: '20–40', label: 'Patchy', color: '#ff9f3a' },
  { range: '40–60', label: 'Solid', color: '#e8e54a' },
  { range: '60–80', label: 'Dominant', color: '#c5ff3a' },
  { range: '80+', label: 'Rare air', color: '#f5c842' },
] as const;

export function TurfScoreShowcase() {
  return (
    <div
      className="rounded-xl border p-6 md:p-7 mb-8 relative overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 12px 48px #c5ff3a14, 0 0 0 1px #c5ff3a22',
      }}
    >
      {/* Ambient lime glow centered behind the score numerals.
       *  pointer-events:none so it never intercepts clicks. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 50% 60% at 50% 35%, #c5ff3a14 0%, transparent 65%)',
        }}
      />

      {/* ─── Score card ──────────────────────────────────────────────── */}
      <div className="relative flex flex-col items-center text-center mb-7">
        <div className="flex items-center gap-2 mb-3">
          <Target size={14} style={{ color: 'var(--color-lime)' }} />
          <span className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500">
            Your TurfScore
          </span>
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <span
            className="font-display font-black leading-none tracking-tight"
            style={{
              color: 'var(--color-lime)',
              fontSize: 'clamp(4rem, 14vw, 6.5rem)',
              textShadow: '0 0 60px #c5ff3a44',
              animation: 'turfmap-score-pulse 2.4s ease-in-out infinite',
            }}
          >
            ??
          </span>
          <span className="font-display text-2xl md:text-3xl font-bold text-zinc-400">
            / 100
          </span>
        </div>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500">
          appears in 60 seconds
        </div>
        <style jsx>{`
          @keyframes turfmap-score-pulse {
            0%,
            100% {
              opacity: 0.7;
              transform: scale(1);
            }
            50% {
              opacity: 1;
              transform: scale(1.03);
            }
          }
        `}</style>
      </div>

      {/* ─── Band spectrum ───────────────────────────────────────────── */}
      <div className="relative">
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500 mb-3 text-center">
          Where your score will land
        </div>
        {/* 5 tiles, each carrying the band color + range underneath.
         *  Tile heights are fixed; widths flex equally across the row
         *  on mobile + desktop. */}
        <div className="grid grid-cols-5 gap-1.5">
          {BAND_TILES.map((tile) => (
            <div key={tile.label} className="flex flex-col">
              <div
                className="h-3.5 rounded-sm mb-1.5"
                style={{
                  background: tile.color,
                  boxShadow: `0 0 12px ${tile.color}33`,
                }}
              />
              <div
                className="text-[9px] md:text-[10px] uppercase tracking-wider font-mono font-semibold text-zinc-300 text-center leading-tight"
                style={{ color: tile.color }}
              >
                {tile.label}
              </div>
              <div className="text-[9px] md:text-[10px] font-mono text-zinc-600 text-center mt-0.5">
                {tile.range}
              </div>
            </div>
          ))}
        </div>
        {/* Hint line — keeps the spectrum honest about what the
         *  benchmark is. Most local businesses land 30-55 (matches
         *  the in-app TurfScore card's example text). */}
        <p className="text-[11px] text-zinc-500 text-center leading-relaxed mt-4">
          Most local businesses we scan land{' '}
          <span className="text-zinc-300 font-semibold">
            between 30 and 55
          </span>{' '}
          before optimization.
        </p>
      </div>
    </div>
  );
}
