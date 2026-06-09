/**
 * Aggregate-proportional 81-cell teaser for /yourmap (Part B 5.1).
 *
 * Replaces the prior anonymized sample heatmap whose numbers
 * contradicted the prospect's stated TurfScore. Honors the brief's
 * honesty guardrail by representing ONLY the prospect's real
 * aggregate data (preview_score + invisibility_count), never a
 * fabricated per-cell grid claimed as theirs:
 *
 *   - The COUNT of dimmed (invisible) cells equals invisibility_count
 *     exactly. That number IS their real data.
 *
 *   - The POSITION of the dimmed cells is generated from a stable
 *     hash of the prospect_id (so the same prospect always sees the
 *     same arrangement) but is NOT spatially literal — the label
 *     below makes that explicit. We're showing the proportion they're
 *     missing in their service area, not where exactly.
 *
 *   - The metric row below the grid shows TurfReach + TurfScore
 *     computed from real prospect data. TurfRank is omitted (we
 *     don't store per-cell ranks on the prospect row).
 *
 * The label "Aggregate preview — full scan reveals the per-cell map"
 * is non-optional and prominent. The brief explicitly forbids
 * presenting a fabricated grid as the prospect's actual map.
 */

import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';

/** Stable per-prospect cell layout. Uses a tiny LCG seeded by the
 *  prospect_id so the same buyer always sees the same arrangement
 *  across reloads (consistency = trust). Visible cells render
 *  brightly; invisible cells render dim/red to make the "you're
 *  missing here" pressure visceral. */
function buildCellMask(prospectId: string, invisibleCount: number): boolean[] {
  // boolean[] of length 81. true = visible (lit), false = invisible (dim).
  const TOTAL = 81;
  const invisible = Math.max(0, Math.min(TOTAL, Math.round(invisibleCount)));

  // Hash the prospect_id into a 32-bit seed for the LCG.
  let seed = 2166136261;
  for (let i = 0; i < prospectId.length; i++) {
    seed = (seed ^ prospectId.charCodeAt(i)) * 16777619;
    seed = seed >>> 0;
  }
  // Build a shuffled index array, mark the first `invisible` as dim.
  const idx = Array.from({ length: TOTAL }, (_, i) => i);
  for (let i = TOTAL - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const mask = Array(TOTAL).fill(true);
  for (let i = 0; i < invisible; i++) {
    mask[idx[i]] = false;
  }
  return mask;
}

export function TheirDataTeaser({
  prospectId,
  businessName,
  previewScore,
  invisibilityCount,
}: {
  prospectId: string;
  businessName: string;
  previewScore: number;
  invisibilityCount: number;
}) {
  const cells = buildCellMask(prospectId, invisibilityCount);
  const visibleCount = 81 - invisibilityCount;
  const reachPct = Math.round((visibleCount / 81) * 100);
  const band = getTurfScoreBand(previewScore);

  return (
    <div
      className="border rounded-lg p-5 relative"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 60px #c5ff3a10',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
          {businessName} · Aggregate preview
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-lime)' }}
          />
          YOUR DATA
        </div>
      </div>

      {/* 9x9 grid. Dim cells = invisibility_count; lit cells = the
       *  rest. CSS-only, no SVG, so the grid scales cleanly with
       *  the card width. */}
      <div className="grid grid-cols-9 gap-1.5 aspect-square">
        {cells.map((visible, i) => (
          <div
            key={i}
            className="rounded-full"
            style={{
              background: visible
                ? // Lit cell — visible to searchers
                  'radial-gradient(circle, rgba(197, 255, 58, 0.55) 0%, rgba(197, 255, 58, 0.18) 60%, transparent 100%)'
                : // Dim cell — invisible to searchers, the pressure point
                  'radial-gradient(circle, rgba(239, 68, 68, 0.45) 0%, rgba(239, 68, 68, 0.10) 60%, transparent 100%)',
              border: visible
                ? '1px solid rgba(197, 255, 58, 0.35)'
                : '1px solid rgba(239, 68, 68, 0.25)',
            }}
          />
        ))}
      </div>

      {/* Honesty label — non-optional, prominent. The brief requires
       *  this NOT be presented as a literal per-cell map. */}
      <p className="text-[11px] text-zinc-500 mt-3 leading-relaxed">
        <strong className="text-zinc-300">Aggregate preview</strong> —
        the count of dim cells is your real invisibility number. The
        full scan reveals which specific cells are which, plus your
        rank in each.
      </p>

      {/* Real metric row. TurfReach + TurfScore from prospect data;
       *  TurfRank deliberately not surfaced since we don't store
       *  per-cell ranks on the prospect row. */}
      <div className="mt-4 grid grid-cols-2 gap-3 text-center">
        <div
          className="rounded-md px-2.5 py-3 flex flex-col items-center"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
            TurfReach<sup className="text-[7px]">™</sup>
          </div>
          <div className="font-display text-2xl md:text-3xl font-bold text-zinc-100 leading-none">
            {reachPct}%
          </div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-mono mt-1">
            visible cells
          </div>
        </div>
        <div
          className="rounded-md px-2.5 py-3 flex flex-col items-center"
          style={{
            background: '#0d130a',
            border: '1px solid var(--color-border-bright)',
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
            TurfScore<sup className="text-[7px]">™</sup>
          </div>
          <div
            className="font-display text-2xl md:text-3xl font-bold leading-none"
            style={{ color: 'var(--color-lime)' }}
          >
            {previewScore}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-mono mt-1">
            {band.label}
          </div>
        </div>
      </div>
    </div>
  );
}
