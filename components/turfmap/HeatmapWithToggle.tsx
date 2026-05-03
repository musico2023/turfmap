'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Crown, User } from 'lucide-react';
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
 *
 * UI scales by competitor count:
 *   - 0 competitors → no toggle (just renders the client heatmap)
 *   - 1-2 competitors → pill row (current visual; fast tap)
 *   - 3+ competitors → client pill + a dropdown for the competitor set
 *     so the row doesn't blow out horizontally. The franchise client
 *     case (50+ competitors per location) folds cleanly into search-
 *     ready dropdown without redesign.
 */
export function HeatmapWithToggle({
  clientCells,
  clientName,
  competitors,
}: HeatmapWithToggleProps) {
  type ViewKey = 'client' | `comp-${number}`;
  const [view, setView] = useState<ViewKey>('client');

  const activeCompIndex =
    view === 'client' ? null : Number(view.split('-')[1]);
  const activeCells: HeatmapCell[] =
    activeCompIndex === null
      ? clientCells
      : (competitors[activeCompIndex]?.cells ?? clientCells);
  const activeName =
    activeCompIndex === null
      ? clientName
      : (competitors[activeCompIndex]?.name ?? clientName);

  const useDropdown = competitors.length > 2;

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
          {useDropdown ? (
            <CompetitorDropdown
              competitors={competitors}
              activeIndex={activeCompIndex}
              onSelect={(i) => setView(`comp-${i}` as ViewKey)}
            />
          ) : (
            competitors.map((c, i) => (
              <ViewPill
                key={c.name}
                active={view === `comp-${i}`}
                onClick={() => setView(`comp-${i}` as ViewKey)}
                icon={<Crown size={11} />}
                label={`${truncate(c.name, 22)} · ${c.top3Pct}%`}
              />
            ))
          )}
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

// ─── Internal components ──────────────────────────────────────────────────

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
        borderColor: active
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Dropdown variant for competitor selection. Used when competitors.length
 * is > 2 so the pill row doesn't blow out horizontally. Mirrors the
 * LocationSwitcher pattern (button trigger → panel of rows → outside-
 * click + Escape close) but tighter since competitor stats are simple.
 */
function CompetitorDropdown({
  competitors,
  activeIndex,
  onSelect,
}: {
  competitors: CompetitorView[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = activeIndex !== null ? competitors[activeIndex] : null;
  const triggerLabel = active
    ? `${truncate(active.name, 22)} · ${active.top3Pct}%`
    : `Compare to competitor (${competitors.length})`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="px-2.5 py-1.5 rounded text-[11px] font-mono flex items-center gap-1.5 transition-colors border"
        style={{
          background: active ? '#1a2010' : 'var(--color-card)',
          color: active ? 'var(--color-lime)' : '#a1a1aa',
          borderColor: open
            ? 'var(--color-border-bright)'
            : active
              ? 'var(--color-border-bright)'
              : 'var(--color-border)',
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Crown size={11} />
        {triggerLabel}
        <ChevronDown
          size={11}
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className="absolute z-30 mt-1 w-[280px] rounded-md border shadow-2xl"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
            boxShadow: '0 12px 40px #00000080',
          }}
          role="listbox"
        >
          <ul className="max-h-72 overflow-y-auto py-1">
            {competitors.map((c, i) => {
              const isActive = i === activeIndex;
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(i);
                      setOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-mono hover:bg-white/[0.04] transition-colors text-left"
                    style={{
                      color: isActive ? 'var(--color-lime)' : '#e4e4e7',
                    }}
                    role="option"
                    aria-selected={isActive}
                  >
                    <Check
                      size={11}
                      className="flex-shrink-0"
                      style={{ opacity: isActive ? 1 : 0 }}
                    />
                    <span className="flex-1 min-w-0 truncate">{c.name}</span>
                    <span className="text-zinc-500 flex-shrink-0">
                      {c.top3Pct}%
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div
            className="px-3 py-2 border-t text-[10px] font-mono text-zinc-600"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {competitors.length} competitors · sorted by share
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
