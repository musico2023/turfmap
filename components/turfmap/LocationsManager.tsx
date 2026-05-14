'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, MapPin, Plus, Trash2 } from 'lucide-react';
import type {
  ClientLocationRow,
  SubscriptionTier,
} from '@/lib/supabase/types';
import { extractPostcodeFromAddress } from '@/lib/geocoding/parsePostcode';
import { extraLocationDollarsForTier } from '@/lib/stripe/extraLocations';
import { Button } from '@/components/ui/Button';
import {
  AddressAutocomplete,
  type AddressFields,
} from './AddressAutocomplete';

export type LocationsManagerProps = {
  clientId: string;
  locations: ClientLocationRow[];
  /** Recurring tier — drives the per-location billing copy and the
   *  add-location confirmation dialog. NULL for one_time / agency-
   *  managed clients (no per-location billing). */
  tier?: SubscriptionTier | null;
  /** True iff this client has a Stripe self-serve subscription (i.e.
   *  adding/removing locations actually triggers a Stripe quantity
   *  update). False for agency-managed clients — they see the
   *  location count but no billing copy. */
  selfServeBilling?: boolean;
};

/**
 * Operator-facing list/edit/add UI for a client's locations.
 *
 * - "Add location" expands an inline form. Address auto-geocodes (same
 *   /api/geocode endpoint the create form uses) so structured NAP
 *   fields and lat/lng are populated silently.
 * - Each location row expands to an edit form when clicked.
 * - "Make primary" promotes a non-primary location (atomic — old
 *   primary is demoted server-side).
 * - Delete is gated server-side (can't remove primary while siblings
 *   exist).
 *
 * Keeps the same visual language as KeywordsManager — operator stays
 * in the settings page; no modal navigation.
 */
export function LocationsManager({
  clientId,
  locations,
  tier = null,
  selfServeBilling = false,
}: LocationsManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recentNotice, setRecentNotice] = useState<string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const extraDollars =
    tier && selfServeBilling ? extraLocationDollarsForTier(tier) : 0;
  const additionalCount = Math.max(0, locations.length - 1);
  const monthlyExtras = additionalCount * extraDollars;
  const showBillingLine = selfServeBilling && tier !== null;

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">Locations</h3>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-xl">
            Each physical location has its own scan grid, keywords, and
            citation audit. Multi-location clients (e.g. clinics with two
            offices) need every location listed here so the AI Coach can
            reason about each storefront independently.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setAdding((v) => !v)}
          leftIcon={!adding ? <Plus size={11} /> : undefined}
          className="flex-shrink-0"
        >
          {adding ? 'Cancel' : 'Add location'}
        </Button>
      </div>

      {showBillingLine && (
        <div
          className="rounded-md border px-3 py-2 mb-3 text-xs flex items-center justify-between gap-3"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
            color: '#a1a1aa',
          }}
        >
          <span>
            <span className="text-zinc-300 font-semibold">
              {locations.length} location{locations.length === 1 ? '' : 's'}
            </span>{' '}
            · 1 included
            {additionalCount > 0 && (
              <>
                {' '}
                + {additionalCount} additional × ${extraDollars}/mo
              </>
            )}
          </span>
          {monthlyExtras > 0 && (
            <span className="font-mono text-zinc-200">
              +${monthlyExtras}/mo
            </span>
          )}
        </div>
      )}

      {error && (
        <div
          className="border rounded-md p-3 mb-3 text-xs font-mono"
          style={{
            background: '#1a0606',
            borderColor: '#3f0a0a',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}

      {recentNotice && (
        <div
          className="rounded-md border px-3 py-2 mb-3 text-xs"
          style={{
            background: 'rgba(197, 255, 58, 0.06)',
            borderColor: 'rgba(197, 255, 58, 0.3)',
            color: 'var(--color-lime, #c5ff3a)',
          }}
        >
          {recentNotice}
        </div>
      )}

      {adding && (
        <AddLocationForm
          clientId={clientId}
          existingLocationCount={locations.length}
          tier={tier}
          selfServeBilling={selfServeBilling}
          onCancel={() => setAdding(false)}
          onAdded={(notice) => {
            setAdding(false);
            if (notice) setRecentNotice(notice);
            refresh();
          }}
          onError={setError}
        />
      )}

      <ul className="space-y-2 mt-3">
        {locations.map((loc) => (
          <li
            key={loc.id}
            className="border rounded-md"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <button
              type="button"
              onClick={() =>
                setExpandedId((v) => (v === loc.id ? null : loc.id))
              }
              className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors rounded-md"
            >
              <span
                className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-bold flex-shrink-0"
                style={{
                  background: loc.is_primary ? '#1a2a05' : '#1a1a1a',
                  color: loc.is_primary ? 'var(--color-lime)' : '#a1a1aa',
                }}
              >
                {loc.is_primary ? 'Primary' : 'Location'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-200 truncate">
                  {loc.label || loc.city || 'Unnamed'}
                </div>
                <div className="text-[11px] text-zinc-500 font-mono truncate">
                  {loc.address || '(no address)'}
                </div>
              </div>
              {expandedId === loc.id ? (
                <ChevronDown size={14} className="text-zinc-500" />
              ) : (
                <ChevronRight size={14} className="text-zinc-500" />
              )}
            </button>
            {expandedId === loc.id && (
              <EditLocationForm
                clientId={clientId}
                location={loc}
                onSaved={refresh}
                onError={setError}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Add form ─────────────────────────────────────────────────────────────

function AddLocationForm({
  clientId,
  existingLocationCount,
  tier,
  selfServeBilling,
  onCancel,
  onAdded,
  onError,
}: {
  clientId: string;
  existingLocationCount: number;
  tier: SubscriptionTier | null;
  selfServeBilling: boolean;
  onCancel: () => void;
  onAdded: (notice?: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceRadius, setServiceRadius] = useState('1.6');
  const [submitting, setSubmitting] = useState(false);
  // Mapbox-resolved structured fields. Set when the operator picks a
  // suggestion from the autocomplete dropdown; cleared whenever they
  // edit the freeform address afterward (so we don't ship stale
  // structured data with a hand-typed override).
  const [selected, setSelected] = useState<AddressFields | null>(null);

  // Per-location billing — show a confirmation banner inline when the
  // new location will trigger a $19/$29 add-on charge. The first
  // location is included in the base tier, so the second + onward
  // are the ones that bill. Agency-managed clients (selfServeBilling
  // false) skip the banner entirely.
  const willChargeExtra =
    selfServeBilling && tier !== null && existingLocationCount >= 1;
  const extraDollars =
    selfServeBilling && tier ? extraLocationDollarsForTier(tier) : 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    setSubmitting(true);

    try {
      // Prefer Mapbox-resolved fields when the operator picked from
      // the dropdown — Mapbox already gave us canonical structured
      // data + lat/lng, no need to round-trip through Nominatim.
      // Fall back to /api/geocode for typed-but-not-selected paths.
      let lat: number;
      let lng: number;
      let components: {
        street_address: string | null;
        city: string | null;
        region: string | null;
        postcode: string | null;
        country_code: string | null;
      } | null;

      if (selected && selected.formatted === address.trim()) {
        lat = selected.latitude;
        lng = selected.longitude;
        components = {
          street_address: selected.street_address || null,
          city: selected.city || null,
          region: selected.region || null,
          postcode: selected.postcode || null,
          country_code: selected.country_code
            ? selected.country_code.toUpperCase() === 'CA'
              ? 'CAN'
              : selected.country_code.toUpperCase() === 'US'
                ? 'USA'
                : selected.country_code.toUpperCase()
            : null,
        };
      } else {
        const geo = await fetch('/api/geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.trim() }),
        });
        const geoData = (await geo.json()) as {
          lat?: number;
          lng?: number;
          components?: {
            street_address: string | null;
            city: string | null;
            region: string | null;
            postcode: string | null;
            country_code: string | null;
          } | null;
          error?: string;
        };
        if (!geo.ok || geoData.lat === undefined || geoData.lng === undefined) {
          onError(geoData.error ?? `geocode failed (HTTP ${geo.status})`);
          setSubmitting(false);
          return;
        }
        lat = geoData.lat;
        lng = geoData.lng;
        components = geoData.components ?? null;
      }

      // Operator-typed postcode wins over the resolver's normalized
      // one (preserves what the buyer actually wrote — Mapbox/Nominatim
      // can return a slightly different code than the typed input,
      // which downstream NAP audit flags as inconsistencies).
      const operatorPostcode = extractPostcodeFromAddress(address.trim());
      const finalPostcode = operatorPostcode ?? components?.postcode ?? null;

      const res = await fetch(`/api/clients/${clientId}/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || null,
          address: address.trim(),
          street_address: components?.street_address ?? null,
          city: components?.city ?? null,
          region: components?.region ?? null,
          postcode: finalPostcode,
          country_code: components?.country_code ?? 'USA',
          phone: phone.trim() || null,
          latitude: lat,
          longitude: lng,
          service_radius_miles: Number(serviceRadius),
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        billing?: { ok: boolean; quantity?: number; message?: string } | null;
      };
      if (!res.ok) {
        onError(data.error ?? `add failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      // Surface a one-line proration notice on success when the
      // location actually billed something. Stripe handles the
      // proration math; we just narrate.
      let notice: string | undefined;
      if (willChargeExtra && data.billing?.ok) {
        notice = `Location added. +$${extraDollars}/mo (prorated through next invoice).`;
      } else if (data.billing && !data.billing.ok) {
        // Location succeeded but Stripe sync didn't — flag for ops
        // visibility so the operator can reconcile manually.
        notice = `Location added. Stripe sync failed (${data.billing.message}). Reconcile in dashboard.`;
      }
      onAdded(notice);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="border rounded-md p-3 mb-2 space-y-2"
      style={{ borderColor: 'var(--color-border)', background: '#0d0d0d' }}
    >
      {willChargeExtra && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            background: 'rgba(255, 159, 58, 0.05)',
            borderColor: 'rgba(255, 159, 58, 0.3)',
            color: '#ffb86b',
          }}
        >
          <strong>+${extraDollars}/mo</strong> per additional location on{' '}
          {tier === 'pulse_plus' ? 'Pulse+' : 'Pulse'}. Stripe will prorate
          the charge through your next invoice.
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Don Mills)"
          className={inputClass}
        />
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (+1-…)"
          className={inputClass}
        />
      </div>
      <AddressAutocomplete
        value={address}
        onChange={(next) => {
          setAddress(next);
          // Clear the selected fields if the operator hand-edits
          // after picking — keep the form honest about whether we
          // have canonical structured data or not.
          if (selected && next !== selected.formatted) setSelected(null);
        }}
        onSelect={(fields) => {
          setSelected(fields);
          setAddress(fields.formatted);
        }}
        placeholder="Address — pick from the dropdown"
        required
        inputClassName={inputClass}
      />
      <input
        type="number"
        step="0.1"
        value={serviceRadius}
        onChange={(e) => setServiceRadius(e.target.value)}
        placeholder="Service radius (mi)"
        className={inputClass}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="md"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          loadingLabel="Adding…"
          leftIcon={<MapPin size={11} />}
        >
          Add location
        </Button>
      </div>
    </form>
  );
}

// ─── Edit form ────────────────────────────────────────────────────────────

function EditLocationForm({
  clientId,
  location,
  onSaved,
  onError,
}: {
  clientId: string;
  location: ClientLocationRow;
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const [label, setLabel] = useState(location.label ?? '');
  const [address, setAddress] = useState(location.address ?? '');
  const [phone, setPhone] = useState(location.phone ?? '');
  const [serviceRadius, setServiceRadius] = useState(
    String(location.service_radius_miles ?? 1.6)
  );
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      // Re-geocode if the address changed so structured fields + coords
      // stay in sync. Skip geocoding if the address is unchanged to
      // avoid spamming Nominatim on label-only edits.
      let geocodePayload: Record<string, unknown> = {};
      if (address.trim() !== (location.address ?? '').trim()) {
        const geo = await fetch('/api/geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.trim() }),
        });
        const geoData = (await geo.json()) as {
          lat?: number;
          lng?: number;
          components?: {
            street_address: string | null;
            city: string | null;
            region: string | null;
            postcode: string | null;
            country_code: string | null;
          } | null;
          error?: string;
        };
        if (!geo.ok || geoData.lat === undefined || geoData.lng === undefined) {
          onError(geoData.error ?? `geocode failed (HTTP ${geo.status})`);
          setSubmitting(false);
          return;
        }
        // Same postcode-precedence rule as AddLocationForm: trust the
        // operator's typed postcode when present, fall back to
        // Nominatim's parse only when there's nothing to extract.
        const operatorPostcode = extractPostcodeFromAddress(address.trim());
        geocodePayload = {
          latitude: geoData.lat,
          longitude: geoData.lng,
          street_address: geoData.components?.street_address ?? null,
          city: geoData.components?.city ?? null,
          region: geoData.components?.region ?? null,
          postcode: operatorPostcode ?? geoData.components?.postcode ?? null,
          country_code: geoData.components?.country_code ?? 'USA',
        };
      }

      const res = await fetch(
        `/api/clients/${clientId}/locations/${location.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: label.trim() || null,
            address: address.trim(),
            phone: phone.trim() || null,
            service_radius_miles: Number(serviceRadius),
            ...geocodePayload,
          }),
        }
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        onError(data.error ?? `save failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onMakePrimary = async () => {
    onError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/locations/${location.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_primary: true }),
        }
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        onError(data.error ?? `promote failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async () => {
    if (
      !confirm(
        `Delete this location? Scans and audits tied to it will be unlinked but not deleted.`
      )
    ) {
      return;
    }
    onError(null);
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/locations/${location.id}`,
        { method: 'DELETE' }
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        onError(data.error ?? `delete failed (HTTP ${res.status})`);
        setDeleting(false);
        return;
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <form
      onSubmit={onSave}
      className="border-t p-3 space-y-2"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          className={inputClass}
        />
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone"
          className={inputClass}
        />
      </div>
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Address"
        className={inputClass}
      />
      <input
        type="number"
        step="0.1"
        value={serviceRadius}
        onChange={(e) => setServiceRadius(e.target.value)}
        placeholder="Service radius (mi)"
        className={inputClass}
      />
      <GbpMatchPanel
        clientId={clientId}
        locationId={location.id}
        businessName={location.label ?? location.city ?? ''}
      />
      <div className="flex justify-between items-center gap-2 pt-1">
        <div className="flex gap-2">
          {!location.is_primary && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onMakePrimary}
              disabled={submitting}
            >
              Make primary
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
            disabled={deleting}
            loading={deleting}
            loadingLabel="Deleting…"
            leftIcon={<Trash2 size={10} />}
          >
            Delete
          </Button>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          loadingLabel="Saving…"
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}

// ─── GBP match panel ─────────────────────────────────────────────────────

type GbpMatchState = {
  placeId: string | null;
  status:
    | 'auto'
    | 'confirmed'
    | 'manual'
    | 'rejected'
    | 'no_match'
    | null;
  matchDistanceM: number | null;
  matchNameSimilarity: number | null;
  signals: {
    rating: number | null;
    user_ratings_total: number | null;
    primary_type: string | null;
    types: string[] | null;
    business_status: string | null;
    photos_count: number | null;
    fetched_at: string;
  } | null;
};

type Candidate = {
  placeId: string;
  displayName: string | null;
  formattedAddress: string | null;
  primaryType: string | null;
  rating: number | null;
  userRatingCount: number | null;
};

function GbpMatchPanel({
  clientId,
  locationId,
  businessName,
}: {
  clientId: string;
  locationId: string;
  businessName: string;
}) {
  const [state, setState] = useState<GbpMatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'confirm' | 'reject' | 'select'>(null);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const baseUrl = `/api/clients/${clientId}/locations/${locationId}/gbp-match`;

  const refresh = async () => {
    try {
      const res = await fetch(baseUrl, { method: 'GET' });
      const data = (await res.json()) as GbpMatchState | { error?: string };
      if (res.ok) setState(data as GbpMatchState);
    } catch {
      // Silent — panel just shows nothing
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch on expand. The panel only mounts when the row is
  // expanded (parent unmounts it on collapse), so a one-shot fetch is
  // sufficient — no polling, no resubscribe. The fetch is async, so
  // any setState lands after the effect body returns (lint-safe).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(baseUrl, { method: 'GET' });
        const data = (await res.json()) as GbpMatchState | { error?: string };
        if (!cancelled && res.ok) setState(data as GbpMatchState);
      } catch {
        // Silent — panel just shows nothing.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const callAction = async (
    action: 'confirm' | 'reject',
    afterLabel: GbpMatchState['status']
  ) => {
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? `${action} failed`);
        return;
      }
      // Optimistic update; the next refresh fills in signal blanks.
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: afterLabel,
              placeId: action === 'reject' ? null : prev.placeId,
              signals: action === 'reject' ? null : prev.signals,
            }
          : prev
      );
      if (action === 'reject') setSearchOpen(true);
    } finally {
      setBusy(null);
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setErr(null);
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query: searchQuery.trim() }),
      });
      const data = (await res.json()) as
        | { candidates: Candidate[]; cost_cents: number }
        | { error?: string };
      if (!res.ok) {
        setErr(('error' in data && data.error) || 'search failed');
        return;
      }
      setCandidates(('candidates' in data && data.candidates) || []);
    } finally {
      setSearching(false);
    }
  };

  const pickCandidate = async (placeId: string) => {
    setBusy('select');
    setErr(null);
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'select', placeId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? 'select failed');
        return;
      }
      setSearchOpen(false);
      setCandidates(null);
      setSearchQuery('');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="border rounded-md px-3 py-2 text-[11px] text-zinc-500" style={{ borderColor: 'var(--color-border)' }}>
        Loading GBP match…
      </div>
    );
  }
  if (!state) return null;

  const status = state.status;
  const placeId = state.placeId;
  const sig = state.signals;
  const ratingLine =
    sig && (sig.rating !== null || sig.user_ratings_total !== null)
      ? `${sig.rating !== null ? `${sig.rating.toFixed(1)} ★` : ''}${sig.rating !== null && sig.user_ratings_total !== null ? ' · ' : ''}${sig.user_ratings_total !== null ? `${sig.user_ratings_total} reviews` : ''}`
      : null;

  const badge = (() => {
    if (!status || status === null)
      return { text: 'GBP: not linked', color: '#a1a1aa', bg: '#1a1a1a' };
    if (status === 'auto')
      return {
        text: 'GBP: auto-matched — please confirm',
        color: '#fbbf24',
        bg: '#2a1f05',
      };
    if (status === 'confirmed')
      return { text: 'GBP: confirmed', color: 'var(--color-lime)', bg: '#1a2a05' };
    if (status === 'manual')
      return { text: 'GBP: manually linked', color: 'var(--color-lime)', bg: '#1a2a05' };
    if (status === 'rejected')
      return { text: 'GBP: rejected — search to relink', color: '#f87171', bg: '#2a0606' };
    return { text: 'GBP: no match found — search to link', color: '#a1a1aa', bg: '#1a1a1a' };
  })();

  return (
    <div className="border rounded-md p-2.5 space-y-2 text-[11px]" style={{ borderColor: 'var(--color-border)', background: 'rgba(255,255,255,0.01)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-bold"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.text}
        </span>
        {(status === 'auto' || status === 'confirmed' || status === 'manual') && placeId && (
          <a
            href={`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline"
          >
            view on Google
          </a>
        )}
      </div>
      {sig && (
        <div className="text-zinc-400 leading-relaxed">
          {sig.primary_type && (
            <div>Category: <span className="text-zinc-300">{sig.primary_type}</span></div>
          )}
          {ratingLine && <div>{ratingLine}</div>}
          {sig.business_status && sig.business_status !== 'OPERATIONAL' && (
            <div className="text-amber-400">Status: {sig.business_status}</div>
          )}
        </div>
      )}
      {status === 'auto' && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'confirm'}
            onClick={() => callAction('confirm', 'confirmed')}
          >
            That&apos;s us
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'reject'}
            onClick={() => callAction('reject', 'rejected')}
          >
            Not us — search again
          </Button>
        </div>
      )}
      {(status === 'confirmed' || status === 'manual') && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'reject'}
            onClick={() => callAction('reject', 'rejected')}
          >
            Re-link to a different listing
          </Button>
        </div>
      )}
      {(status === 'rejected' || status === 'no_match' || !status) && !searchOpen && (
        <Button variant="secondary" size="sm" onClick={() => setSearchOpen(true)}>
          Search Google for the right listing
        </Button>
      )}
      {searchOpen && (
        <div className="space-y-2 pt-1 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={businessName || 'Business name + city'}
              className={inputClass}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch();
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              loading={searching}
              onClick={runSearch}
              disabled={!searchQuery.trim()}
            >
              Search
            </Button>
          </div>
          {candidates && candidates.length === 0 && (
            <div className="text-zinc-500">No matches. Try a different query.</div>
          )}
          {candidates && candidates.length > 0 && (
            <ul className="space-y-1">
              {candidates.map((c) => (
                <li
                  key={c.placeId}
                  className="border rounded-md p-2 hover:bg-white/[0.03] cursor-pointer"
                  style={{ borderColor: 'var(--color-border)' }}
                  onClick={() => pickCandidate(c.placeId)}
                >
                  <div className="text-zinc-200 text-xs font-medium">
                    {c.displayName ?? '(no name)'}
                  </div>
                  <div className="text-zinc-500 text-[10px] font-mono">
                    {c.formattedAddress ?? ''}
                  </div>
                  <div className="text-zinc-500 text-[10px]">
                    {[
                      c.primaryType,
                      c.rating !== null ? `${c.rating.toFixed(1)} ★` : null,
                      c.userRatingCount !== null
                        ? `${c.userRatingCount} reviews`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {err && <div className="text-red-400">{err}</div>}
    </div>
  );
}

const inputClass =
  'w-full px-2.5 py-1.5 rounded-md border bg-[var(--color-card)] border-[var(--color-border)] text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors';
