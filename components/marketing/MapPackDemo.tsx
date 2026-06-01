/**
 * MapPackDemo — flat/stylized illustration of Google's Local 3-pack.
 *
 * Sits in section 02's headerAside slot, beside the "You checked
 * your rank once" H2. The point is to anchor what a "map pack" is
 * visually — most prospects haven't internalized that local search
 * for service businesses shows a 3-business box at the top of the
 * results, and that ranking IN that box is what TurfMap measures.
 *
 * Not a real screenshot — a stylized recreation in TurfMap's dark
 * palette so it reads as "this is what Google shows," not "this is
 * a screenshot of Anthony's competitor's page." Real Google
 * screenshots would clash with the rest of the dark-themed UI
 * AND get into trademark gray area.
 *
 * Rank colors echo the heatmap palette (#1 lime → #2 yellow → #3
 * orange) so the buyer sees a consistent ranking vocabulary across
 * the whole page.
 *
 * Self-contained, no props — drop in anywhere a Map Pack primer
 * is useful.
 */

import { Star, MapPin } from 'lucide-react';

type PackEntry = {
  rank: 1 | 2 | 3;
  name: string;
  rating: number;
  reviews: number;
  category: string;
};

// Fictional plumbers, deliberately generic-named so they don't
// imply any real business. The homepage's hero trade is plumbers
// (rotating-label has plumbers as the default), so the trade
// matches the rest of the page's voice.
const ENTRIES: PackEntry[] = [
  {
    rank: 1,
    name: 'Atlas Plumbing & Drain',
    rating: 4.8,
    reviews: 142,
    category: 'Plumber',
  },
  {
    rank: 2,
    name: 'Quick Pipe Pros',
    rating: 4.6,
    reviews: 87,
    category: 'Plumber',
  },
  {
    rank: 3,
    name: 'Maple City Plumbers',
    rating: 4.4,
    reviews: 53,
    category: 'Plumber',
  },
];

const RANK_COLORS = {
  1: '#c5ff3a', // lime
  2: '#e8e54a', // yellow
  3: '#ff9f3a', // orange
} as const;

export function MapPackDemo() {
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 12px 48px #c5ff3a14',
      }}
    >
      {/* Eyebrow + small header to label what this is */}
      <div
        className="px-4 py-3 flex items-center justify-between border-b"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold text-zinc-500">
          Google&apos;s local 3-pack
        </div>
        <MapPin size={12} className="text-zinc-600" />
      </div>

      {/* Stylized map. Pure SVG — no real geography, just enough
       *  "lines = roads + pins = businesses" shapes to read as a
       *  map at a glance. Three lime pins clustered, matching the
       *  three entries below. */}
      <div className="px-4 pt-3">
        <div
          className="relative rounded-md overflow-hidden"
          style={{
            background: '#0d130a',
            border: '1px solid var(--color-border)',
            height: 110,
          }}
        >
          <svg
            viewBox="0 0 280 110"
            className="absolute inset-0 w-full h-full"
            aria-hidden
          >
            {/* Abstract "roads" — faint zinc lines crossing the
             *  field. Just enough to read as a city grid. */}
            <g stroke="#1f1f1f" strokeWidth="1" fill="none">
              <path d="M0 35 L280 30" />
              <path d="M0 75 L280 78" />
              <path d="M60 0 L65 110" />
              <path d="M160 0 L155 110" />
              <path d="M230 0 L232 110" />
            </g>
            {/* Slightly brighter accent road */}
            <path
              d="M0 55 L280 52"
              stroke="#2a2a1a"
              strokeWidth="1.5"
              fill="none"
            />
            {/* Lime water/park shape in the corner */}
            <path
              d="M210 90 Q240 85 270 95 L280 110 L210 110 Z"
              fill="#c5ff3a"
              fillOpacity="0.08"
            />
            {/* Three pins — one per rank. Color matches the entry's
             *  rank chip below for visual continuity. */}
            <g>
              {[
                { x: 95, y: 45, color: RANK_COLORS[1] },
                { x: 145, y: 60, color: RANK_COLORS[2] },
                { x: 185, y: 40, color: RANK_COLORS[3] },
              ].map((pin, i) => (
                <g key={i}>
                  {/* Pin shadow + outer ring + inner dot */}
                  <circle
                    cx={pin.x}
                    cy={pin.y + 1}
                    r={6}
                    fill="rgba(0,0,0,0.6)"
                  />
                  <circle cx={pin.x} cy={pin.y} r={6} fill={pin.color} />
                  <circle cx={pin.x} cy={pin.y} r={2} fill="#0a0a0a" />
                </g>
              ))}
            </g>
          </svg>
        </div>
      </div>

      {/* Three listings, one per pack entry. Compact rows — no
       *  CTAs (Website/Directions buttons from the real Google UI),
       *  just the data the buyer needs to grasp the concept. */}
      <ul className="px-4 py-3 space-y-2.5">
        {ENTRIES.map((entry) => (
          <li
            key={entry.name}
            className="flex items-start gap-2.5 text-sm leading-tight"
          >
            {/* Rank chip — same color as the matching map pin. */}
            <div
              className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center font-display font-bold text-[11px]"
              style={{
                background: RANK_COLORS[entry.rank],
                color: '#0a0a0a',
              }}
              aria-hidden
            >
              {entry.rank}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-zinc-100 truncate">
                {entry.name}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 mt-0.5">
                <Star
                  size={10}
                  fill="#f5c842"
                  stroke="#f5c842"
                  className="flex-shrink-0"
                />
                <span className="text-zinc-300 font-mono">
                  {entry.rating.toFixed(1)}
                </span>
                <span className="font-mono">({entry.reviews})</span>
                <span className="text-zinc-700">·</span>
                <span className="truncate">{entry.category}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Bottom caption — the punchline. Connects the static
       *  illustration to the page's argument: which 3 you see
       *  depends on where you stand. */}
      <div
        className="px-4 py-3 border-t text-[11px] text-zinc-500 leading-relaxed"
        style={{
          borderColor: 'var(--color-border)',
          background: '#0d0d0d',
        }}
      >
        These 3 businesses change{' '}
        <span className="text-zinc-300 font-semibold">
          every time the searcher moves
        </span>{' '}
        — even by a block. TurfMap measures all 81.
      </div>
    </div>
  );
}
