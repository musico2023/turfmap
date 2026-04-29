'use client';

import { useState } from 'react';
import { Crown, User } from 'lucide-react';
import { HeatmapGrid, type HeatmapCell } from './HeatmapGrid';

export type CompetitorView = {
  name: string;
  amr: number;
  top3Pct: number;
  cells: HeatmapCell[];
};

export type HeatmapWithToggleProps = {
  /** The client's own per-cell ranks. */
  clientCells: HeatmapCell[];
  /** Display name for the client (shown when "You" view is active). */
  clientName: string;
  /** Top observed competitors with pre-computed per-cell ranks. */
  competitors: CompetitorView[];
};

/**
 * Wraps HeatmapGrid with a toggle that flips between the client's heatmap
 * and any of the top competitors'. Pure client-side — the parent server
 * component pre-computes every cell array so the toggle is instant.
 */
export function HeatmapWithToggle({
  clientCells,
  clientName,
  competitors,
}: HeatmapWithToggleProps) {
  type ViewKey = 'client' | `comp-${number}`;
  const [view, setView] = useState<ViewKey>('client');

  const activeCells: HeatmapCell[] =
    view === 'client'
      ? clientCells
      : competitors[Number(view.split('-')[1])]?.cells ?? clientCells;

  const activeName =
    view === 'client'
      ? clientName
      : competitors[Number(view.split('-')[1])]?.name ?? clientName;

  return (
    <div>
      {competitors.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mr-1">
            View
          </span>
          <ViewPill
            active={view === 'client'}
            onClick={() => setView('client')}
            icon={<User size={11} />}
            label={truncate(clientName, 28)}
          />
          {competitors.map((c, i) => (
            <ViewPill
              key={c.name}
              active={view === `comp-${i}`}
              onClick={() => setView(`comp-${i}` as ViewKey)}
              icon={<Crown size={11} />}
              label={`${truncate(c.name, 22)} · ${c.top3Pct}%`}
            />
          ))}
        </div>
      )}

      <HeatmapGrid cells={activeCells} animateReveal={false} />

      <div className="text-center mt-3 text-[11px] text-zinc-500 font-mono">
        {view === 'client' ? (
          <>Showing <span className="text-zinc-300">{truncate(activeName, 60)}</span></>
        ) : (
          <>
            Competitor view ·{' '}
            <span className="text-zinc-300">{truncate(activeName, 60)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function ViewPill({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1.5 rounded text-[11px] font-mono flex items-center gap-1.5 transition-colors border"
      style={{
        background: active ? '#1a2010' : 'var(--color-card)',
        color: active ? 'var(--color-lime)' : '#a1a1aa',
        borderColor: active ? 'var(--color-border-bright)' : 'var(--color-border)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
