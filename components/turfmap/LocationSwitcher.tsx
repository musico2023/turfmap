'use client';

import Link from 'next/link';
import { MapPin } from 'lucide-react';
import type { ClientLocationRow } from '@/lib/supabase/types';

export type LocationSwitcherProps = {
  clientId: string;
  locations: ClientLocationRow[];
  activeLocationId: string | null;
};

/**
 * Pill-row switcher rendered above the dashboard for multi-location
 * clients. Hidden when the client has ≤ 1 location to keep single-
 * location flows visually unchanged.
 *
 * Each pill links to `?location=<id>` — the dashboard reads that and
 * scopes its scans/keywords/AI Coach data to the selected location.
 */
export function LocationSwitcher({
  clientId,
  locations,
  activeLocationId,
}: LocationSwitcherProps) {
  if (locations.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5">
        <MapPin size={11} /> Location
      </span>
      {locations.map((loc) => {
        const isActive = loc.id === activeLocationId;
        const label = loc.label || loc.city || 'Unnamed';
        return (
          <Link
            key={loc.id}
            href={`/clients/${clientId}?location=${loc.id}`}
            className="px-3 py-1.5 rounded-md text-xs font-mono border transition-colors flex items-center gap-1.5"
            style={{
              borderColor: isActive
                ? 'var(--color-lime)'
                : 'var(--color-border)',
              background: isActive ? '#0d130a' : 'var(--color-card)',
              color: isActive ? 'var(--color-lime)' : '#a1a1aa',
            }}
          >
            {label}
            {loc.is_primary && (
              <span className="text-[9px] uppercase tracking-wider text-zinc-600">
                primary
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
