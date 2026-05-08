'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Tag } from 'lucide-react';
import type { TrackedKeywordRow } from '@/lib/supabase/types';

export type KeywordSwitcherProps = {
  /** Tolerant — the page URL may use the public_id slug or the UUID. */
  clientId: string;
  /** Keywords scoped to the active location. Caller filters; we just
   *  render the list. Renders as a non-interactive pill when this
   *  list has exactly 1 entry — the keyword is always visible in the
   *  strip so operators don't have to scan a separate "Tracking
   *  Keyword" column further down to know which keyword the heatmap
   *  is showing. Returns null only when the list is empty. */
  keywords: Pick<TrackedKeywordRow, 'id' | 'keyword' | 'is_primary'>[];
  /** Currently-selected keyword id. When null the page is implicitly
   *  showing the location's primary (or first) keyword's latest scan. */
  activeKeywordId: string | null;
};

/**
 * Per-location keyword switcher. Each (location, keyword) pair has its
 * own scan history and heatmap, and the dashboard only shows one at a
 * time — this is how the operator cycles between them.
 *
 * Modeled after LocationSwitcher: same dropdown affordance, same URL-
 * driven state, search input appears when the list grows past 8. The
 * URL contract preserves whatever query params are already on the page
 * (e.g. ?location=<id>) and adds/replaces ?keyword=<id> so location +
 * keyword switchers compose without stepping on each other.
 */
export function KeywordSwitcher({
  clientId,
  keywords,
  activeKeywordId,
}: KeywordSwitcherProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
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

  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  const showSearch = keywords.length > 8;

  const filtered = useMemo(() => {
    if (!query.trim()) return keywords;
    const q = query.trim().toLowerCase();
    return keywords.filter((k) => k.keyword.toLowerCase().includes(q));
  }, [keywords, query]);

  if (keywords.length === 0) return null;

  const active =
    keywords.find((k) => k.id === activeKeywordId) ??
    keywords.find((k) => k.is_primary) ??
    keywords[0];

  // Single-keyword case: render as a non-interactive pill so the
  // active keyword is always visible at the top of the page. Same
  // eyebrow + box dimensions as the multi-keyword button below so
  // the strip's visual rhythm doesn't shift across clients with
  // 1 vs N keywords. No chevron, no click handler — purely
  // informational.
  if (keywords.length === 1) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5">
          <Tag size={11} /> Keyword
        </span>
        <div
          className="px-3 py-1.5 rounded-md text-xs font-mono border flex items-center w-full sm:w-auto sm:min-w-[200px]"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-card)',
            color: '#e4e4e7',
          }}
          aria-label={`Tracking keyword: ${active.keyword}`}
        >
          <span className="flex-1 text-left truncate">
            {active.keyword}
            {active.is_primary && (
              <span className="text-[9px] uppercase tracking-wider text-zinc-600 ml-1.5">
                primary
              </span>
            )}
          </span>
        </div>
      </div>
    );
  }

  // Build the href for each row — preserves existing query params (the
  // ?location=<id> on multi-location clients) and just swaps the
  // ?keyword=<id> entry.
  const buildHref = (keywordId: string) => {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.set('keyword', keywordId);
    return `${basePath}?${next.toString()}`;
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5">
        <Tag size={11} /> Keyword
      </span>

      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-3 py-1.5 rounded-md text-xs font-mono border transition-colors flex items-center gap-2 w-full sm:w-auto sm:min-w-[200px]"
          style={{
            borderColor: open ? 'var(--color-lime)' : 'var(--color-border)',
            background: open ? '#0d130a' : 'var(--color-card)',
            color: open ? 'var(--color-lime)' : '#e4e4e7',
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="flex-1 text-left truncate">
            {active?.keyword ?? 'Select keyword'}
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
            className="absolute z-30 mt-1 w-[min(320px,calc(100vw-2rem))] rounded-md border shadow-2xl"
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
                    placeholder={`Search ${keywords.length} keywords…`}
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
                  No keywords match {`"${query}"`}.
                </li>
              ) : (
                filtered.map((kw) => {
                  const isActive = kw.id === active?.id;
                  return (
                    <li key={kw.id}>
                      <Link
                        href={buildHref(kw.id)}
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
                          style={{ opacity: isActive ? 1 : 0 }}
                        />
                        <span className="flex-1 min-w-0 font-mono truncate">
                          {kw.keyword}
                          {kw.is_primary && (
                            <span className="text-[9px] uppercase tracking-wider text-zinc-600 ml-1.5">
                              primary
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
                {filtered.length} of {keywords.length} shown
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
