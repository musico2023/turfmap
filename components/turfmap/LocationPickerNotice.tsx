import Link from 'next/link';
import { MapPin } from 'lucide-react';

/**
 * Banner shown above the citation onboarding form. Tells the operator
 * exactly which location they're configuring (citations are per
 * location — separate orders, separate BL submissions, separate
 * profiles), and offers quick-switch links to sibling locations so
 * they can't accidentally submit a profile for the wrong storefront.
 */

type ActiveLocation = {
  id: string;
  label: string;
  street_address: string | null;
  city: string | null;
  region: string | null;
};

type OtherLocation = {
  id: string;
  label: string;
};

export function LocationPickerNotice({
  clientPublicId,
  activeLocation,
  otherLocations,
}: {
  clientPublicId: string;
  activeLocation: ActiveLocation;
  otherLocations: OtherLocation[];
}) {
  const addressParts = [
    activeLocation.street_address,
    activeLocation.city,
    activeLocation.region,
  ].filter(Boolean);

  return (
    <div
      className="border rounded-lg p-4 mb-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="rounded-md p-2 shrink-0"
          style={{
            background: 'rgba(197, 255, 58, 0.08)',
            border: '1px solid rgba(197, 255, 58, 0.2)',
          }}
        >
          <MapPin size={14} className="text-[var(--color-accent)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Configuring citations for
          </div>
          <div className="font-display text-base font-bold mt-0.5">
            {activeLocation.label}
          </div>
          {addressParts.length > 0 && (
            <div className="text-xs text-zinc-500 font-mono mt-0.5">
              {addressParts.join(' · ')}
            </div>
          )}
          {otherLocations.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5">
                Switch location
              </div>
              <div className="flex flex-wrap gap-1.5">
                {otherLocations.map((loc) => (
                  <Link
                    key={loc.id}
                    href={`/clients/${clientPublicId}/citations/setup?location=${loc.id}`}
                    className="text-xs font-mono px-2 py-1 rounded border text-zinc-300 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                    style={{
                      background: 'var(--color-bg)',
                      borderColor: 'var(--color-border)',
                    }}
                  >
                    {loc.label}
                  </Link>
                ))}
              </div>
              <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
                Each location gets its own citation order. Submitting here
                only affects {activeLocation.label}.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
