'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ChevronDown, ChevronRight, MapPin, Plus, Trash2 } from 'lucide-react';
import type { ClientLocationRow } from '@/lib/supabase/types';

export type LocationsManagerProps = {
  clientId: string;
  locations: ClientLocationRow[];
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
export function LocationsManager({ clientId, locations }: LocationsManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

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
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors hover:border-zinc-700 flex items-center gap-1.5 flex-shrink-0"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-card)',
            color: '#a1a1aa',
          }}
        >
          <Plus size={11} /> {adding ? 'Cancel' : 'Add location'}
        </button>
      </div>

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

      {adding && (
        <AddLocationForm
          clientId={clientId}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
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
  onCancel,
  onAdded,
  onError,
}: {
  clientId: string;
  onCancel: () => void;
  onAdded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceRadius, setServiceRadius] = useState('1.6');
  const [gbpUrl, setGbpUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    setSubmitting(true);

    try {
      // 1. Geocode the address to get lat/lng + structured components.
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
      const c = geoData.components;

      // 2. POST the new location with the resolved coords + components.
      const res = await fetch(`/api/clients/${clientId}/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || null,
          address: address.trim(),
          street_address: c?.street_address ?? null,
          city: c?.city ?? null,
          region: c?.region ?? null,
          postcode: c?.postcode ?? null,
          country_code: c?.country_code ?? 'USA',
          phone: phone.trim() || null,
          latitude: geoData.lat,
          longitude: geoData.lng,
          service_radius_miles: Number(serviceRadius),
          gbp_url: gbpUrl.trim() || null,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        onError(data.error ?? `add failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      onAdded();
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
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Address (geocodes silently)"
        required
        className={inputClass}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          step="0.1"
          value={serviceRadius}
          onChange={(e) => setServiceRadius(e.target.value)}
          placeholder="Service radius (mi)"
          className={inputClass}
        />
        <input
          type="url"
          value={gbpUrl}
          onChange={(e) => setGbpUrl(e.target.value)}
          placeholder="GBP URL (optional)"
          className={inputClass}
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ background: 'var(--color-lime)', color: 'black' }}
        >
          {submitting ? (
            <>
              <Activity size={11} className="animate-pulse" /> Adding…
            </>
          ) : (
            <>
              <MapPin size={11} /> Add location
            </>
          )}
        </button>
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
  const [gbpUrl, setGbpUrl] = useState(location.gbp_url ?? '');
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
        geocodePayload = {
          latitude: geoData.lat,
          longitude: geoData.lng,
          street_address: geoData.components?.street_address ?? null,
          city: geoData.components?.city ?? null,
          region: geoData.components?.region ?? null,
          postcode: geoData.components?.postcode ?? null,
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
            gbp_url: gbpUrl.trim() || null,
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
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          step="0.1"
          value={serviceRadius}
          onChange={(e) => setServiceRadius(e.target.value)}
          placeholder="Service radius (mi)"
          className={inputClass}
        />
        <input
          type="url"
          value={gbpUrl}
          onChange={(e) => setGbpUrl(e.target.value)}
          placeholder="GBP URL"
          className={inputClass}
        />
      </div>
      <div className="flex justify-between items-center gap-2 pt-1">
        <div className="flex gap-2">
          {!location.is_primary && (
            <button
              type="button"
              onClick={onMakePrimary}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md text-[11px] font-mono border transition-colors hover:border-zinc-700 disabled:opacity-50"
              style={{
                borderColor: 'var(--color-border)',
                color: '#a1a1aa',
              }}
            >
              Make primary
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="px-3 py-1.5 rounded-md text-[11px] font-mono border transition-colors hover:border-red-700 hover:text-red-400 disabled:opacity-50 flex items-center gap-1"
            style={{
              borderColor: 'var(--color-border)',
              color: '#a1a1aa',
            }}
          >
            <Trash2 size={10} /> {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ background: 'var(--color-lime)', color: 'black' }}
        >
          {submitting ? (
            <>
              <Activity size={11} className="animate-pulse" /> Saving…
            </>
          ) : (
            'Save changes'
          )}
        </button>
      </div>
    </form>
  );
}

const inputClass =
  'w-full px-2.5 py-1.5 rounded-md border bg-[var(--color-card)] border-[var(--color-border)] text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors';
