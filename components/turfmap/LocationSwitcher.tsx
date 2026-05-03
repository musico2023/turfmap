'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MapPin } from 'lucide-react';
import type { ClientLocationRow } from '@/lib/supabase/types';

export type LocationSwitcherProps = {
  clientId: string;
  locations: ClientLocationRow[];
  activeLocationId: string | null;
};

/**
 * Pill-row switcher for multi-location clients. Renders above any page
 * that scopes its content to a single location (dashboard, settings).
 * Hidden when the client has ≤ 1 location to keep single-location flows
 * visually unchanged.
 *
 * Each pill keeps the operator on the CURRENT pathname (settings stays
 * on settings, dashboard stays on dashboard) and just swaps the
 * `?location=<id>` query param so the page re-fetches its data scoped
 * to the new location.
 */
export function LocationSwitcher({
  clientId,
  locations,
  activeLocationId,
}: LocationSwitcherProps) {
  // Preserve the current sub-page (e.g. /clients/:id/settings) so
  // switching locations doesn't throw the operator back to the dashboard.
  // Falls back to /clients/:id if usePathname returns something unexpected.
  const pathname = usePathname();
  const basePath =
    pathname && pathname.startsWith(`/clients/${clientId}`)
      ? pathname
      : `/clients/${clientId}`;

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
            href={`${basePath}?location=${loc.id}`}
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
