'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Search, X } from 'lucide-react';
import type { ClientRow } from '@/lib/supabase/types';

/**
 * Searchable client roster for the agency-owner /clients page.
 *
 * Server fetches the (already alphabetized) client list once and
 * passes it here; this component renders a live filter input + the
 * client grid. Filtering is in-memory — for an agency book that's
 * tens to low-hundreds of clients, this is faster and snappier than
 * round-tripping to the server on each keystroke.
 *
 * Match logic: case-insensitive substring across business_name,
 * address, and industry. Operators looking for "the plumber on 5th
 * ave" can hit the address; operators auditing all roofers can
 * type the industry.
 */
export function ClientRoster({ clients }: { clients: ClientRow[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => {
      const haystack = [
        c.business_name,
        c.address ?? '',
        c.industry ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [clients, query]);

  return (
    <>
      {/* Search bar — full-width on mobile, capped on desktop. The
       *  Search icon is absolutely positioned inside the input so the
       *  affordance reads as "search this roster" without taking a
       *  separate row. The X button only renders when the field has
       *  content, mirroring the Keyword switcher's clear behavior. */}
      <div className="mb-5 max-w-md">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${clients.length} client${clients.length === 1 ? '' : 's'}…`}
            className="w-full pl-9 pr-9 py-2 rounded-md text-sm bg-[var(--color-card)] border border-[var(--color-border)] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
            aria-label="Search clients"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors p-0.5"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div
          className="border rounded-lg p-8 text-center"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <p className="text-sm text-zinc-400">
            No clients match{' '}
            <span className="font-mono text-zinc-200">
              &ldquo;{query}&rdquo;
            </span>
            .
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            Searches business name, address, and industry.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((c) => (
            <Link
              key={c.id}
              href={`/clients/${c.public_id}`}
              className="border rounded-lg p-5 transition-colors hover:border-zinc-700 group"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border)',
              }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                  {c.industry ?? 'Local business'}
                </div>
                <ChevronRight
                  size={16}
                  className="text-zinc-600 group-hover:text-zinc-300 transition-colors"
                />
              </div>
              <div className="font-display text-lg font-semibold leading-snug mb-1">
                {c.business_name}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {c.address}
              </div>
              <div className="mt-4 flex items-center gap-2 text-[11px] font-mono text-zinc-600">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    background:
                      c.status === 'active' ? 'var(--color-lime)' : '#666',
                  }}
                />
                <span className="uppercase tracking-wider">
                  {c.status ?? 'unknown'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
