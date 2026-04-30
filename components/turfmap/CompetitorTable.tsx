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
 * Top 3-pack competitors observed across the scan, sorted by AMR (best first).
 * If we don't have enough scan data yet, render the empty state.
 */
export function CompetitorTable({ competitors }: CompetitorTableProps) {
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
        <div className="space-y-3">
          {competitors.map((c, i) => {
            const absent = c.top3Pct === 0;
            return (
              <div
                key={`${c.name}-${i}`}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <span
                    className={`font-mono text-xs w-3.5 flex-shrink-0 ${
                      absent ? 'text-zinc-700' : 'text-zinc-600'
                    }`}
                  >
                    {i + 1}
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
                    {i === 0 && (
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
                    {i === 0 && (
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
      )}
    </div>
  );
}
