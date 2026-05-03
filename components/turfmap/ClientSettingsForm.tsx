'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, MapPin, Save } from 'lucide-react';
import type { ClientRow, ClientStatus } from '@/lib/supabase/types';
import { LogoUploader } from './LogoUploader';
import { extractPostcodeFromAddress } from '@/lib/geocoding/parsePostcode';
import { Button } from '@/components/ui/Button';

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
];

type Form = {
  business_name: string;
  address: string;
  latitude: string;
  longitude: string;
  // Structured NAP — required for BrightLocal citation audits, optional
  // here to support pre-NAP-migration clients.
  phone: string;
  street_address: string;
  city: string;
  region: string;
  postcode: string;
  country_code: string;
  industry: string;
  service_radius_miles: string;
  monthly_price_dollars: string;
  status: ClientStatus;
};

function formFromClient(c: ClientRow): Form {
  return {
    business_name: c.business_name,
    address: c.address,
    latitude: String(c.latitude),
    longitude: String(c.longitude),
    phone: c.phone ?? '',
    street_address: c.street_address ?? '',
    city: c.city ?? '',
    region: c.region ?? '',
    postcode: c.postcode ?? '',
    country_code: c.country_code ?? 'USA',
    industry: c.industry ?? '',
    service_radius_miles: String(c.service_radius_miles ?? 1.6),
    monthly_price_dollars:
      c.monthly_price_cents == null
        ? ''
        : (c.monthly_price_cents / 100).toFixed(2).replace(/\.00$/, ''),
    status: (c.status ?? 'active') as ClientStatus,
  };
}

type FillState =
  | { status: 'idle' }
  | { status: 'looking' }
  | { status: 'filled'; filled: number }
  | { status: 'failed'; error: string };

export function ClientSettingsForm({ client }: { client: ClientRow }) {
  const router = useRouter();
  const [original] = useState<Form>(() => formFromClient(client));
  const [form, setForm] = useState<Form>(() => formFromClient(client));
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fillState, setFillState] = useState<FillState>({ status: 'idle' });
  const [, startTransition] = useTransition();

  const update = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((s) => ({ ...s, [k]: v }));
    setSavedAt(null);
  };

  /**
   * Re-geocode the freeform `address` and refresh the hidden structured
   * citation fields (street/city/region/postcode/country) plus lat/lng.
   * This is an explicit user action (the "re-geocode" link) so we overwrite
   * existing values rather than just filling gaps — the operator changed
   * the address, the new geocode is canonical.
   */
  const fillFromAddress = async () => {
    const addr = form.address.trim();
    if (addr.length < 4) {
      setFillState({
        status: 'failed',
        error: 'enter a full address first',
      });
      return;
    }
    setFillState({ status: 'looking' });
    try {
      const res = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      const data = (await res.json()) as {
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
      if (!res.ok) {
        setFillState({
          status: 'failed',
          error: data.error ?? `geocode failed (HTTP ${res.status})`,
        });
        return;
      }
      const c = data.components;
      // Operator-typed postcode wins over Nominatim's normalized one.
      // Re-geocode is an explicit action, but the operator's text input
      // is still the source of truth for what they meant.
      const operatorPostcode = extractPostcodeFromAddress(addr);
      const finalPostcode = operatorPostcode ?? c?.postcode ?? null;
      let filled = 0;
      setForm((s) => {
        const next = { ...s };
        if (data.lat !== undefined) next.latitude = String(data.lat);
        if (data.lng !== undefined) next.longitude = String(data.lng);
        if (c?.street_address && c.street_address !== s.street_address) {
          next.street_address = c.street_address;
          filled++;
        }
        if (c?.city && c.city !== s.city) {
          next.city = c.city;
          filled++;
        }
        if (c?.region && c.region !== s.region) {
          next.region = c.region;
          filled++;
        }
        if (finalPostcode && finalPostcode !== s.postcode) {
          next.postcode = finalPostcode;
          filled++;
        }
        if (c?.country_code && c.country_code !== s.country_code) {
          next.country_code = c.country_code;
          filled++;
        }
        return next;
      });
      setSavedAt(null);
      setFillState({ status: 'filled', filled });
    } catch (e) {
      setFillState({
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const dirty = (Object.keys(form) as Array<keyof Form>).some(
    (k) => form[k] !== original[k]
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const lat = Number(form.latitude);
    const lng = Number(form.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setError('latitude and longitude must be numbers');
      return;
    }

    // Build the patch body — only send keys that actually changed so we
    // don't pointlessly rewrite immutable rows.
    const patch: Record<string, unknown> = {};
    if (form.business_name !== original.business_name) patch.business_name = form.business_name.trim();
    if (form.address !== original.address) patch.address = form.address.trim();
    if (form.latitude !== original.latitude) patch.latitude = lat;
    if (form.longitude !== original.longitude) patch.longitude = lng;
    // NAP fields — empty string clears (null) so operator can blank a wrong value.
    if (form.phone !== original.phone)
      patch.phone = form.phone.trim() === '' ? null : form.phone.trim();
    if (form.street_address !== original.street_address)
      patch.street_address =
        form.street_address.trim() === '' ? null : form.street_address.trim();
    if (form.city !== original.city)
      patch.city = form.city.trim() === '' ? null : form.city.trim();
    if (form.region !== original.region)
      patch.region = form.region.trim() === '' ? null : form.region.trim();
    if (form.postcode !== original.postcode)
      patch.postcode = form.postcode.trim() === '' ? null : form.postcode.trim();
    if (form.country_code !== original.country_code)
      patch.country_code =
        form.country_code.trim() === ''
          ? null
          : form.country_code.trim().toUpperCase().slice(0, 3);
    if (form.industry !== original.industry)
      patch.industry = form.industry.trim() === '' ? null : form.industry.trim();
    if (form.service_radius_miles !== original.service_radius_miles)
      patch.service_radius_miles = Number(form.service_radius_miles);
    if (form.status !== original.status) patch.status = form.status;
    if (form.monthly_price_dollars !== original.monthly_price_dollars) {
      if (form.monthly_price_dollars.trim() === '') {
        patch.monthly_price_cents = null;
      } else {
        const dollars = Number(form.monthly_price_dollars);
        if (Number.isNaN(dollars) || dollars < 0) {
          setError('monthly price must be a non-negative number');
          return;
        }
        patch.monthly_price_cents = Math.round(dollars * 100);
      }
    }

    if (Object.keys(patch).length === 0) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      setSavedAt(Date.now());
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-3xl">
      <Section title="Business">
        <Field label="Business name" required>
          <input
            type="text"
            value={form.business_name}
            onChange={(e) => update('business_name', e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Phone" help="E.164 preferred, e.g. +1-416-555-0100">
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => update('phone', e.target.value)}
            placeholder="+1-416-555-0100"
            className={inputClass}
          />
        </Field>
        <Field
          label="Address"
          required
          help={
            <button
              type="button"
              onClick={fillFromAddress}
              disabled={fillState.status === 'looking'}
              className="text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {fillState.status === 'looking' ? (
                <>
                  <Activity size={11} className="animate-pulse" /> re-geocoding…
                </>
              ) : (
                <>
                  <MapPin size={11} /> re-geocode
                </>
              )}
            </button>
          }
        >
          <input
            type="text"
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        {fillState.status === 'filled' && fillState.filled > 0 && (
          <p className="text-[11px] font-mono text-zinc-500 -mt-1 mb-1">
            ✓ refreshed {fillState.filled} citation{' '}
            {fillState.filled === 1 ? 'field' : 'fields'} from geocode
          </p>
        )}
        {fillState.status === 'failed' && (
          <p className="text-[11px] font-mono text-red-400 -mt-1 mb-1">
            {fillState.error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude" required>
            <input
              type="number"
              step="0.0000001"
              value={form.latitude}
              onChange={(e) => update('latitude', e.target.value)}
              required
              className={inputClass}
            />
          </Field>
          <Field label="Longitude" required>
            <input
              type="number"
              step="0.0000001"
              value={form.longitude}
              onChange={(e) => update('longitude', e.target.value)}
              required
              className={inputClass}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry">
            <input
              type="text"
              list="industry-suggestions-edit"
              value={form.industry}
              onChange={(e) => update('industry', e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
            <datalist id="industry-suggestions-edit">
              {INDUSTRY_SUGGESTIONS.map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </Field>
          <Field label="Service radius (mi)">
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

      <Section title="White-label + billing">
        {/* White-label scope is intentionally narrow: just the logo.
         *  Per-client brand accent colors were removed — operators
         *  picked arbitrary hexes that clashed with the lime/dark
         *  instrument aesthetic, and every portal ended up looking like
         *  a different (and worse) product. The `clients.primary_color`
         *  column stays in the schema as historical data but is no
         *  longer surfaced or read. */}
        <LogoUploader
          clientId={client.id}
          initialLogoUrl={client.logo_url}
          businessName={client.business_name}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly price (USD)">
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
                className={`${inputClass} pl-7`}
              />
            </div>
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => update('status', e.target.value as ClientStatus)}
              className={inputClass}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="churned">Churned</option>
            </select>
          </Field>
        </div>
      </Section>

      <div className="flex items-center justify-end gap-3">
        {error && (
          <span className="text-xs text-red-400 font-mono mr-auto max-w-md">
            {error}
          </span>
        )}
        {!error && savedAt && (
          <span className="text-xs text-zinc-500 font-mono mr-auto">
            ✓ Saved
          </span>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={!dirty}
          loading={submitting}
          loadingLabel="Saving…"
          leftIcon={<Save size={14} />}
        >
          {dirty ? 'Save changes' : 'No changes'}
        </Button>
      </div>
    </form>
  );
}

const inputClass =
  'w-full px-3 py-2 rounded-md border bg-[var(--color-card)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <h3 className="font-display text-lg font-bold mb-4">{title}</h3>
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
