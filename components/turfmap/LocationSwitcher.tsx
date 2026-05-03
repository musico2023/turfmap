'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, MapPin, Search } from 'lucide-react';
import type { ClientLocationRow } from '@/lib/supabase/types';

export type LocationSwitcherProps = {
  clientId: string;
  locations: ClientLocationRow[];
  activeLocationId: string | null;
};

/**
 * Multi-location switcher rendered above any page that scopes to a single
 * location (operator dashboard, settings, white-label portal). Hidden
 * entirely when the client has ≤ 1 location so single-location flows
 * stay visually clean.
 *
 * Designed to scale from 2 to thousands of locations:
 *   - Always a dropdown (not pills) — pills break visually past ~6
 *     locations, and Anthony has a franchise client pushing 58.
 *   - Search input appears once locations.length > 8 so the operator
 *     can type to filter down to "north york" / "wychwood" / etc.
 *     Below that threshold the full list fits without help.
 *   - Each row uses a real <Link> so right-click "open in new tab"
 *     and middle-click work, and keyboard Tab/Enter navigates.
 *
 * URL contract: clicking a row keeps the operator on the current sub-
 * page (settings stays on settings, dashboard stays on dashboard,
 * portal stays on portal) and just swaps the ?location=<id> query
 * param. The page server-resolves that param and re-renders.
 */
export function LocationSwitcher({
  clientId,
  locations,
  activeLocationId,
}: LocationSwitcherProps) {
  const pathname = usePathname();
  const basePath =
    pathname && pathname.startsWith(`/clients/${clientId}`)
      ? pathname
      : pathname && pathname.startsWith(`/portal/${clientId}`)
        ? pathname
        : pathname ?? `/clients/${clientId}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click + Escape.
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

  // Auto-focus the search input when opening, if it's rendered.
  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  const showSearch = locations.length > 8;

  const filtered = useMemo(() => {
    if (!query.trim()) return locations;
    const q = query.trim().toLowerCase();
    return locations.filter((l) => {
      const haystack = [l.label, l.city, l.region, l.address]
        .filter(Boolean)
        .join(' · ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [locations, query]);

  if (locations.length <= 1) return null;

  const active =
    locations.find((l) => l.id === activeLocationId) ?? locations[0];
  const activeLabel = displayLabel(active);
  const activeSubtitle = displaySubtitle(active);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5">
        <MapPin size={11} /> Location
      </span>

      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-3 py-1.5 rounded-md text-xs font-mono border transition-colors flex items-center gap-2 min-w-[180px]"
          style={{
            borderColor: open
              ? 'var(--color-lime)'
              : 'var(--color-border)',
            background: open ? '#0d130a' : 'var(--color-card)',
            color: open ? 'var(--color-lime)' : '#e4e4e7',
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="flex-1 text-left truncate">
            {activeLabel}
            {active?.is_primary && (
              <span className="text-[9px] uppercase tracking-wider text-zinc-600 ml-1.5">
                primary
              </span>
            )}
          </span>
          <ChevronDown
            size={12}
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div
            className="absolute z-30 mt-1 w-[320px] rounded-md border shadow-2xl"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
              boxShadow: '0 12px 40px #00000080',
            }}
            role="listbox"
          >
            {showSearch && (
              <div
                className="p-2 border-b"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <div className="relative">
                  <Search
                    size={12}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${locations.length} locations…`}
                    className="w-full pl-7 pr-2 py-1.5 rounded text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                </div>
              </div>
            )}

            <ul
              className="max-h-80 overflow-y-auto py-1"
              role="presentation"
            >
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-zinc-500 italic">
                  No locations match {`"${query}"`}.
                </li>
              ) : (
                filtered.map((loc) => {
                  const isActive = loc.id === activeLocationId;
                  return (
                    <li key={loc.id}>
                      <Link
                        href={`${basePath}?location=${loc.id}`}
                        onClick={() => setOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/[0.04] transition-colors"
                        style={{
                          color: isActive ? 'var(--color-lime)' : '#e4e4e7',
                        }}
                        role="option"
                        aria-selected={isActive}
                      >
                        <Check
                          size={11}
                          className="flex-shrink-0"
                          style={{
                            opacity: isActive ? 1 : 0,
                          }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block font-mono truncate">
                            {displayLabel(loc)}
                            {loc.is_primary && (
                              <span className="text-[9px] uppercase tracking-wider text-zinc-600 ml-1.5">
                                primary
                              </span>
                            )}
                          </span>
                          {displaySubtitle(loc) && (
                            <span className="block text-[10px] text-zinc-500 truncate mt-0.5">
                              {displaySubtitle(loc)}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })
              )}
            </ul>

            {showSearch && (
              <div
                className="px-3 py-2 border-t text-[10px] font-mono text-zinc-600"
                style={{ borderColor: 'var(--color-border)' }}
              >
                {filtered.length} of {locations.length} shown
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subtitle outside the dropdown — adds context for the active
          location without crowding the trigger button. Hidden when the
          dropdown is open since the panel itself shows full info. */}
      {!open && activeSubtitle && (
        <span className="text-[11px] font-mono text-zinc-600 truncate max-w-[280px]">
          {activeSubtitle}
        </span>
      )}
    </div>
  );
}

function displayLabel(loc: ClientLocationRow | null | undefined): string {
  if (!loc) return 'Select location';
  if (loc.label && loc.label.trim()) return loc.label.trim();
  if (loc.city) return loc.city;
  if (loc.address) return loc.address.split(',')[0].trim();
  return 'Unnamed location';
}

function displaySubtitle(
  loc: ClientLocationRow | null | undefined
): string | null {
  if (!loc) return null;
  // If the label IS the city, show the address. If the label is something
  // bespoke (e.g. "Wychwood" while city is "Toronto"), show city + address.
  if (loc.label && loc.city && loc.label.trim() !== loc.city) {
    return loc.address ? `${loc.city} · ${loc.address}` : loc.city;
  }
  return loc.address ?? null;
}
