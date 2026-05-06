/**
 * Tab navigation for the client settings page.
 *
 * URL-driven so the parent server component can read the active tab
 * from searchParams without round-tripping through client state.
 * Each tab is a Link that preserves the active `location` query param
 * (so keywords/competitors stay scoped to the location the operator
 * was looking at when they switched tabs).
 *
 * Active styling matches the lime-on-dark agency surface — same idiom
 * as the other agency-side nav surfaces.
 */

import Link from 'next/link';

export type SettingsTabId = 'general' | 'tracking' | 'plan' | 'danger';

const TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'plan', label: 'Plan & Access' },
  { id: 'danger', label: 'Danger zone' },
];

export function SettingsTabs({
  basePath,
  active,
  locationId,
}: {
  /** /clients/[publicId]/settings */
  basePath: string;
  active: SettingsTabId;
  /** The currently-selected location, preserved across tab switches.
   *  Null on single-location clients. */
  locationId?: string | null;
}) {
  const buildHref = (tab: SettingsTabId): string => {
    const params = new URLSearchParams();
    if (tab !== 'general') params.set('tab', tab);
    if (locationId) params.set('location', locationId);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div
      className="border-b mb-6 -mx-2 px-2"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <nav className="flex gap-1 overflow-x-auto" aria-label="Settings tabs">
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={buildHref(tab.id)}
              className="px-3 py-2 text-xs font-medium tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors"
              style={{
                color: isActive ? 'var(--color-lime, #c5ff3a)' : '#a1a1aa',
                borderColor: isActive ? 'var(--color-lime, #c5ff3a)' : 'transparent',
              }}
              aria-current={isActive ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function isSettingsTabId(v: unknown): v is SettingsTabId {
  return v === 'general' || v === 'tracking' || v === 'plan' || v === 'danger';
}
