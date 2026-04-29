'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ChevronRight, MapPin } from 'lucide-react';

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
];

type Form = {
  business_name: string;
  address: string;
  latitude: string;
  longitude: string;
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
  industry: '',
  service_radius_miles: '1.6',
  primary_color: '#c5ff3a',
  monthly_price_dollars: '',
  keyword: '',
  scan_frequency: 'weekly',
};

export function ClientCreateForm() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const update = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const lat = Number(form.latitude);
    const lng = Number(form.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setError('latitude and longitude must be numbers');
      return;
    }

    const body: Record<string, unknown> = {
      business_name: form.business_name.trim(),
      address: form.address.trim(),
      latitude: lat,
      longitude: lng,
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
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      startTransition(() => router.push(`/clients/${data.id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-3xl">
      {/* Business basics */}
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
        <Field label="Street address" required>
          <input
            type="text"
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
            placeholder="100 Queen St W, Toronto, ON M5H 2N2"
            required
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Latitude"
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
              value={form.latitude}
              onChange={(e) => update('latitude', e.target.value)}
              placeholder="43.6532"
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
              placeholder="-79.3832"
              required
              className={inputClass}
            />
          </Field>
        </div>
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
          disabled={submitting}
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
