'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';

export type CompetitorRow = {
  name: string;
  /** Average map rank across all points where they appeared. */
  amr: number;
  /** % of points where they were in the top 3. */
  top3Pct: number;
};

export type CompetitorTableProps = {
  competitors: CompetitorRow[];
};

/**
 * Top 3-pack competitors observed across the scan.
 *
 * Two buckets:
 *   - In-pack — brands that appeared in the 3-pack on at least one
 *     grid cell. Always rendered.
 *   - Tracked but not in pack — curated brands the operator's tracking
 *     for this client (via the `competitors` table) that didn't show
 *     up in this scan's 3-pack on a single cell. Hidden behind an
 *     expander by default since 0%-share rows used to dominate the
 *     vertical space and read as noise. Surfaced with a tooltip
 *     explaining what 0% share actually means (whitespace signal).
 */
export function CompetitorTable({ competitors }: CompetitorTableProps) {
  const inPack = competitors.filter((c) => c.top3Pct > 0);
  const absent = competitors.filter((c) => c.top3Pct === 0);
  const [showAbsent, setShowAbsent] = useState(false);

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
          3-Pack Competitors
          <InfoTooltip>
            Brands tracked for this client. Each row shows their average map
            rank when present, and the % of the 81 grid cells where they
            appear in the local 3-pack.
          </InfoTooltip>
        </div>
        <span className="text-[10px] font-mono text-zinc-600">live</span>
      </div>

      {competitors.length === 0 ? (
        <div className="text-xs text-zinc-600 italic">
          No competitor data yet — run a scan first.
        </div>
      ) : (
        <>
          {inPack.length === 0 ? (
            <div className="text-xs text-zinc-600 italic mb-3">
              No tracked competitor appeared in the 3-pack on this scan —
              every cell is yours or unranked.
            </div>
          ) : (
            <CompetitorList rows={inPack} startIndex={0} showAmrTooltip />
          )}

          {absent.length > 0 && (
            <div
              className={`mt-3 pt-3 border-t`}
              style={{ borderColor: 'var(--color-border)' }}
            >
              <button
                type="button"
                onClick={() => setShowAbsent((v) => !v)}
                className="w-full flex items-center justify-between text-[11px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-expanded={showAbsent}
              >
                <span className="inline-flex items-center gap-1.5">
                  <ChevronRight
                    size={11}
                    className={`transition-transform ${showAbsent ? 'rotate-90' : ''}`}
                  />
                  + {absent.length} tracked but not in pack
                  <InfoTooltip side="top">
                    Brands you&rsquo;re tracking that didn&rsquo;t appear in
                    the 3-pack on a single grid cell of this scan. A 0% share
                    is itself a signal — it means this competitor has no
                    visible presence in this territory for this keyword, so
                    you&rsquo;re effectively in whitespace against them here.
                  </InfoTooltip>
                </span>
              </button>

              {showAbsent && (
                <div className="mt-3">
                  <CompetitorList
                    rows={absent}
                    startIndex={inPack.length}
                    showAmrTooltip={false}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CompetitorList({
  rows,
  startIndex,
  showAmrTooltip,
}: {
  rows: CompetitorRow[];
  startIndex: number;
  showAmrTooltip: boolean;
}) {
  return (
    <div className="space-y-3">
      {rows.map((c, i) => {
        const absent = c.top3Pct === 0;
        const rowIndex = startIndex + i;
        return (
          <div
            key={`${c.name}-${rowIndex}`}
            className="flex items-center justify-between text-sm"
          >
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <span
                className={`font-mono text-xs w-3.5 flex-shrink-0 ${
                  absent ? 'text-zinc-700' : 'text-zinc-600'
                }`}
              >
                {rowIndex + 1}
              </span>
              <span
                className={`truncate ${
                  absent ? 'text-zinc-500' : 'text-zinc-200'
                }`}
              >
                {c.name}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs flex-shrink-0">
              <span className="font-mono text-zinc-500 inline-flex items-center gap-1">
                AMR{' '}
                <span
                  className={
                    absent ? 'text-zinc-600' : 'text-zinc-300 font-semibold'
                  }
                >
                  {absent ? '—' : c.amr.toFixed(1)}
                </span>
                {i === 0 && showAmrTooltip && (
                  <InfoTooltip side="top">
                    Average map rank across cells where this brand
                    appeared in the local 3-pack. Lower = better. Cells
                    where the brand is absent are <em>not</em> counted, so
                    a brand in 1 cell at #1 shows AMR 1.0. Use AMR
                    together with Share to gauge actual dominance.
                  </InfoTooltip>
                )}
              </span>
              <span
                className={`font-mono inline-flex items-center gap-1 ${
                  absent ? 'text-zinc-700' : 'text-zinc-500'
                }`}
              >
                Share {c.top3Pct}%
                {i === 0 && showAmrTooltip && (
                  <InfoTooltip side="top">
                    % of the 81 grid cells where this brand appears in
                    the local 3-pack. Measures territory presence — a
                    brand at 23% covers nearly a quarter of the
                    searchable area.
                  </InfoTooltip>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
