'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Save } from 'lucide-react';
import type { ClientRow, ClientStatus } from '@/lib/supabase/types';

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

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
  industry: string;
  service_radius_miles: string;
  primary_color: string;
  monthly_price_dollars: string;
  status: ClientStatus;
  logo_url: string;
};

function formFromClient(c: ClientRow): Form {
  return {
    business_name: c.business_name,
    address: c.address,
    latitude: String(c.latitude),
    longitude: String(c.longitude),
    industry: c.industry ?? '',
    service_radius_miles: String(c.service_radius_miles ?? 1.6),
    primary_color: c.primary_color ?? '#c5ff3a',
    monthly_price_dollars:
      c.monthly_price_cents == null
        ? ''
        : (c.monthly_price_cents / 100).toFixed(2).replace(/\.00$/, ''),
    status: (c.status ?? 'active') as ClientStatus,
    logo_url: c.logo_url ?? '',
  };
}

export function ClientSettingsForm({ client }: { client: ClientRow }) {
  const router = useRouter();
  const [original] = useState<Form>(() => formFromClient(client));
  const [form, setForm] = useState<Form>(() => formFromClient(client));
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const update = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((s) => ({ ...s, [k]: v }));
    setSavedAt(null);
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
    if (!HEX_COLOR.test(form.primary_color.trim())) {
      setError('brand accent must be hex like #c5ff3a');
      return;
    }

    // Build the patch body — only send keys that actually changed so we
    // don't pointlessly rewrite immutable rows.
    const patch: Record<string, unknown> = {};
    if (form.business_name !== original.business_name) patch.business_name = form.business_name.trim();
    if (form.address !== original.address) patch.address = form.address.trim();
    if (form.latitude !== original.latitude) patch.latitude = lat;
    if (form.longitude !== original.longitude) patch.longitude = lng;
    if (form.industry !== original.industry)
      patch.industry = form.industry.trim() === '' ? null : form.industry.trim();
    if (form.service_radius_miles !== original.service_radius_miles)
      patch.service_radius_miles = Number(form.service_radius_miles);
    if (form.primary_color !== original.primary_color)
      patch.primary_color = form.primary_color.trim();
    if (form.logo_url !== original.logo_url)
      patch.logo_url = form.logo_url.trim() === '' ? null : form.logo_url.trim();
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
        <Field label="Street address" required>
          <input
            type="text"
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            required
            className={inputClass}
          />
        </Field>
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
        <Field label="Brand accent color">
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
        <Field label="Logo URL" help="Optional. Used in the white-label portal header.">
          <input
            type="url"
            value={form.logo_url}
            onChange={(e) => update('logo_url', e.target.value)}
            placeholder="https://example.com/logo.png"
            className={inputClass}
          />
        </Field>
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
        <button
          type="submit"
          disabled={submitting || !dirty}
          className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
            boxShadow: '0 4px 16px #c5ff3a30',
          }}
        >
          {submitting ? (
            <>
              <Activity size={14} className="animate-pulse" /> Saving…
            </>
          ) : (
            <>
              <Save size={14} /> {dirty ? 'Save changes' : 'No changes'}
            </>
          )}
        </button>
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
