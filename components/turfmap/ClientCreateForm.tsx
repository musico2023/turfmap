'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Check, ChevronRight, MapPin, X } from 'lucide-react';
import { extractPostcodeFromAddress } from '@/lib/geocoding/parsePostcode';

// Common picks. The form accepts any free-text value — these are just
// suggestions surfaced via <datalist>.
const INDUSTRY_SUGGESTIONS = [
  'plumbing',
  'hvac',
  'roofing',
  'electrical',
  'landscaping',
  'pest control',
  'cleaning',
  'garage doors',
  'locksmith',
  'septic services',
  'pool maintenance',
  'tree care',
  'appliance repair',
  'concrete',
  'fencing',
  'pressure washing',
  'window cleaning',
  'painting',
  'flooring',
  'drywall',
  'home healthcare',
];

type Form = {
  business_name: string;
  address: string;
  latitude: string;
  longitude: string;
  /** Structured NAP fields — required for BrightLocal citation audits.
   *  Kept separate from the freeform `address` field above (which is used
   *  for geocoding). BrightLocal's Listings API needs them broken out. */
  phone: string;
  street_address: string;
  city: string;
  region: string;
  postcode: string;
  country_code: string;
  industry: string;
  service_radius_miles: string;
  primary_color: string;
  /** User-facing dollar amount (e.g. "3500" or "3500.00"). Converted to
   *  integer cents on submit to match the DB column. */
  monthly_price_dollars: string;
  keyword: string;
  scan_frequency: 'weekly' | 'biweekly' | 'monthly' | 'daily';
};

const initial: Form = {
  business_name: '',
  address: '',
  latitude: '',
  longitude: '',
  phone: '',
  street_address: '',
  city: '',
  region: '',
  postcode: '',
  country_code: 'USA',
  industry: '',
  service_radius_miles: '1.6',
  primary_color: '#c5ff3a',
  monthly_price_dollars: '',
  keyword: '',
  scan_frequency: 'weekly',
};

type GeocodeState =
  | { status: 'idle' }
  | { status: 'looking' }
  | { status: 'found'; lat: number; lng: number; formatted: string }
  | { status: 'failed'; error: string };

const GEOCODE_DEBOUNCE_MS = 600;

export function ClientCreateForm() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const [geocode, setGeocode] = useState<GeocodeState>({ status: 'idle' });
  const [manualOverride, setManualOverride] = useState(false);

  const update = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  // ─── Auto-geocode on address change (debounced) ────────────────────────
  useEffect(() => {
    if (manualOverride) return;
    const trimmed = form.address.trim();
    if (trimmed.length < 4) {
      setGeocode({ status: 'idle' });
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setGeocode({ status: 'looking' });
      try {
        const res = await fetch('/api/geocode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: trimmed }),
        });
        const data = (await res.json()) as {
          lat?: number;
          lng?: number;
          formatted?: string;
          components?: {
            street_address: string | null;
            city: string | null;
            region: string | null;
            postcode: string | null;
            country_code: string | null;
          } | null;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.lat === undefined || data.lng === undefined) {
          setGeocode({
            status: 'failed',
            error: data.error ?? `geocode failed (HTTP ${res.status})`,
          });
          return;
        }
        // Auto-populate lat/lng + structured NAP fields on the form.
        // NAP fields fill ONLY IF currently empty so we don't clobber
        // any in-progress edits. User can still tweak coords via manual
        // override if Nominatim's pin is off.
        // Postcode precedence: operator-typed > Nominatim-normalized.
        // Nominatim sometimes returns a different code than the operator
        // intended; trusting their input here prevents the audit from
        // later flagging real listings as inconsistencies.
        const c = data.components;
        const operatorPostcode = extractPostcodeFromAddress(trimmed);
        setForm((s) => ({
          ...s,
          latitude: String(data.lat),
          longitude: String(data.lng),
          street_address: s.street_address || (c?.street_address ?? ''),
          city: s.city || (c?.city ?? ''),
          region: s.region || (c?.region ?? ''),
          postcode: s.postcode || operatorPostcode || (c?.postcode ?? ''),
          // country_code starts as 'USA' default; only let Nominatim
          // override when it's still at the default (i.e. operator
          // hasn't manually changed it).
          country_code:
            s.country_code === 'USA' && c?.country_code
              ? c.country_code
              : s.country_code,
        }));
        setGeocode({
          status: 'found',
          lat: data.lat!,
          lng: data.lng!,
          formatted: data.formatted ?? trimmed,
        });
      } catch (e) {
        if (cancelled) return;
        setGeocode({
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, GEOCODE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.address, manualOverride]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const lat = Number(form.latitude);
    const lng = Number(form.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng) || form.latitude === '' || form.longitude === '') {
      setError(
        manualOverride
          ? 'enter both latitude and longitude'
          : "we couldn't auto-locate that address — click \"override coordinates manually\" to enter them"
      );
      return;
    }

    const body: Record<string, unknown> = {
      business_name: form.business_name.trim(),
      address: form.address.trim(),
      latitude: lat,
      longitude: lng,
      // Structured NAP fields — go through whether or not they're filled,
      // so the create endpoint stores them. Empty strings → null at the route.
      phone: form.phone.trim() || null,
      street_address: form.street_address.trim() || null,
      city: form.city.trim() || null,
      region: form.region.trim() || null,
      postcode: form.postcode.trim() || null,
      country_code: form.country_code.trim().toUpperCase() || 'USA',
      service_radius_miles: Number(form.service_radius_miles),
      primary_color: form.primary_color.trim() || '#c5ff3a',
      keyword: {
        keyword: form.keyword.trim(),
        scan_frequency: form.scan_frequency,
        is_primary: true,
      },
    };
    if (form.industry) body.industry = form.industry;
    if (form.monthly_price_dollars) {
      const dollars = Number(form.monthly_price_dollars);
      if (Number.isNaN(dollars) || dollars < 0) {
        setError('monthly price must be a non-negative number');
        return;
      }
      // Round to integer cents to dodge float drift on values like 99.99 → 9999.
      body.monthly_price_cents = Math.round(dollars * 100);
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        id?: string;
        public_id?: string;
        error?: string;
      };
      if (!res.ok || !data.id) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      // Redirect to the short public_id URL when present (post-migration
      // 0007); fall back to UUID for the brief window where the column
      // hasn't been backfilled yet.
      const slug = data.public_id ?? data.id;
      startTransition(() => router.push(`/clients/${slug}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-3xl">
      {/* Business basics — the structured citation fields (street/city/state/
          zip/country) live in form state but are filled silently from the
          Nominatim geocode below. They're stored on the row and used by the
          NAP audit pipeline. The operator only sees: name, phone, address. */}
      <Section title="Business">
        <Field label="Business name" required>
          <input
            type="text"
            value={form.business_name}
            onChange={(e) => update('business_name', e.target.value)}
            placeholder="Mr. Rooter Plumbing of Toronto"
            required
            autoFocus
            className={inputClass}
          />
        </Field>
        <Field label="Phone" required help="E.164 preferred, e.g. +1-416-555-0100">
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => update('phone', e.target.value)}
            placeholder="+1-416-555-0100"
            required
            className={inputClass}
          />
        </Field>
        <Field label="Address" required>
          <input
            type="text"
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            placeholder="100 Queen St W, Toronto, ON M5H 2N2"
            required
            className={inputClass}
          />
        </Field>

        {/* Geocode status — always rendered, content varies by state */}
        <GeocodeStatus
          state={geocode}
          manualOverride={manualOverride}
          onToggleOverride={() => setManualOverride((v) => !v)}
        />

        {/* Lat/lng inputs only show in manual-override mode */}
        {manualOverride && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude" required>
              <input
                type="number"
                step="0.0000001"
                value={form.latitude}
                onChange={(e) => update('latitude', e.target.value)}
                placeholder="43.6532"
                required
                className={inputClass}
              />
            </Field>
            <Field
              label="Longitude"
              required
              help={
                <a
                  href="https://www.latlong.net/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
                >
                  <MapPin size={11} /> find lat/lng
                </a>
              }
            >
              <input
                type="number"
                step="0.0000001"
                value={form.longitude}
                onChange={(e) => update('longitude', e.target.value)}
                placeholder="-79.3832"
                required
                className={inputClass}
              />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry" help="Optional. Free-text — pick a suggestion or type your own.">
            <input
              type="text"
              list="industry-suggestions"
              value={form.industry}
              onChange={(e) => update('industry', e.target.value)}
              placeholder="plumbing"
              className={inputClass}
              autoComplete="off"
            />
            <datalist id="industry-suggestions">
              {INDUSTRY_SUGGESTIONS.map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </Field>
          <Field label="Service radius (mi)" help="Default 1.6 fits a 9×9 / 0.4mi grid">
            <input
              type="number"
              step="0.1"
              value={form.service_radius_miles}
              onChange={(e) => update('service_radius_miles', e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      {/* Tracking keyword */}
      <Section
        title="Primary tracking keyword"
        subtitle="At least one keyword is required. You can add more later."
      >
        <Field label="Keyword" required>
          <input
            type="text"
            value={form.keyword}
            onChange={(e) => update('keyword', e.target.value)}
            placeholder="emergency plumber toronto"
            required
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label="Scan frequency">
          <select
            value={form.scan_frequency}
            onChange={(e) =>
              update('scan_frequency', e.target.value as Form['scan_frequency'])
            }
            className={inputClass}
          >
            <option value="weekly">Weekly (cron)</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
            <option value="daily">Daily (expensive — $0.16/day)</option>
          </select>
        </Field>
      </Section>

      {/* White-label + billing */}
      <Section title="White-label + billing">
        <Field
          label="Brand accent color"
          help="Hex like #c5ff3a — used in their portal."
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={form.primary_color}
              onChange={(e) => update('primary_color', e.target.value)}
              className={`${inputClass} font-mono`}
            />
            <div
              className="w-9 h-9 rounded border"
              style={{
                background: form.primary_color,
                borderColor: 'var(--color-border)',
              }}
            />
          </div>
        </Field>
        <Field label="Monthly price (USD)" help="Optional. Stored as integer cents internally.">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm pointer-events-none">
              $
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.monthly_price_dollars}
              onChange={(e) => update('monthly_price_dollars', e.target.value)}
              placeholder="3500"
              className={`${inputClass} pl-7`}
            />
          </div>
        </Field>
      </Section>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {error && (
          <span className="text-xs text-red-400 font-mono mr-auto max-w-md">
            {error}
          </span>
        )}
        <button
          type="submit"
          disabled={submitting || geocode.status === 'looking'}
          className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
            boxShadow: '0 4px 16px #c5ff3a30',
          }}
        >
          {submitting ? (
            <>
              <Activity size={14} className="animate-pulse" /> Creating…
            </>
          ) : (
            <>
              Create client <ChevronRight size={14} />
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function GeocodeStatus({
  state,
  manualOverride,
  onToggleOverride,
}: {
  state: GeocodeState;
  manualOverride: boolean;
  onToggleOverride: () => void;
}) {
  // Always-visible footer line below the address field. The "manual
  // override" toggle is here so users can swap to coords-only without
  // hunting for it elsewhere.
  return (
    <div className="flex items-start justify-between gap-3 -mt-1">
      <div className="text-xs text-zinc-500 font-mono leading-relaxed flex-1 min-w-0">
        {state.status === 'idle' && (
          <span className="text-zinc-600">
            We&apos;ll auto-locate this address (free, via OpenStreetMap).
          </span>
        )}
        {state.status === 'looking' && (
          <span className="text-zinc-400 inline-flex items-center gap-1.5">
            <Activity size={11} className="animate-pulse" /> Looking up coordinates…
          </span>
        )}
        {state.status === 'found' && (
          <span className="inline-flex items-start gap-1.5 text-zinc-300">
            <Check
              size={12}
              className="flex-shrink-0 mt-0.5"
              style={{ color: 'var(--color-lime)' }}
            />
            <span className="truncate">
              <span style={{ color: 'var(--color-lime)' }}>
                {state.lat.toFixed(5)}, {state.lng.toFixed(5)}
              </span>
              <span className="text-zinc-600 mx-1.5">·</span>
              <span className="text-zinc-500">{state.formatted}</span>
            </span>
          </span>
        )}
        {state.status === 'failed' && (
          <span className="inline-flex items-start gap-1.5 text-zinc-400">
            <X size={12} className="flex-shrink-0 mt-0.5 text-red-400" />
            <span>{state.error}</span>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onToggleOverride}
        className="text-[11px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0 whitespace-nowrap"
      >
        {manualOverride ? '← back to auto-locate' : 'override coordinates manually →'}
      </button>
    </div>
  );
}

const inputClass =
  'w-full px-3 py-2 rounded-md border bg-[var(--color-card)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors';

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4">
        <h3 className="font-display text-lg font-bold">{title}</h3>
        {subtitle && (
          <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center justify-between">
        <span>
          {label}
          {required && <span className="text-zinc-600 ml-1">*</span>}
        </span>
        {help && <span className="text-[10px] normal-case tracking-normal">{help}</span>}
      </label>
      {children}
    </div>
  );
}
