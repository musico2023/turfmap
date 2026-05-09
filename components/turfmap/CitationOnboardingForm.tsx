'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CategoryCombobox } from '@/components/turfmap/CategoryCombobox';
import { GBP_CATEGORIES } from '@/lib/citations/gbp-categories';

/**
 * Pulse+ citation-build onboarding form. Collects the BrightLocal-
 * specific fields beyond the standard NAP that lives on
 * client_locations: primary + additional GBP categories, description,
 * weekly hours, photo URLs, website.
 *
 * On submit, POSTs to /api/citations/build with the consolidated
 * profile snapshot. Successful submission redirects to the Citations
 * panel on the agency dashboard.
 */

const DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
] as const;

type DayState = {
  /** "open" = open with hours, "closed" = no business that day,
   *  "24h" = open 24 hours. */
  mode: 'open' | 'closed' | '24h';
  /** "HH:MM" — only meaningful when mode === 'open'. */
  open: string;
  /** "HH:MM" — only meaningful when mode === 'open'. */
  close: string;
};

const DEFAULT_DAY: DayState = { mode: 'open', open: '09:00', close: '17:00' };
const CLOSED_DAY: DayState = { mode: 'closed', open: '', close: '' };

const DEFAULT_HOURS: Record<string, DayState> = {
  mon: DEFAULT_DAY,
  tue: DEFAULT_DAY,
  wed: DEFAULT_DAY,
  thu: DEFAULT_DAY,
  fri: DEFAULT_DAY,
  sat: CLOSED_DAY,
  sun: CLOSED_DAY,
};

type Props = {
  clientId: string;
  clientPublicId: string;
  locationId: string;
  businessName: string;
  industry: string | null;
  prefilledLocation: {
    street_address: string | null;
    city: string | null;
    region: string | null;
    postcode: string | null;
    country_code: string | null;
    phone: string | null;
  };
};

export function CitationOnboardingForm({
  clientId,
  clientPublicId,
  locationId,
  businessName,
  industry,
  prefilledLocation,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Only prefill if the client's industry matches a known GBP category;
  // otherwise leave blank so the operator picks from the dropdown.
  const prefilledPrimary = useMemo(() => {
    if (!industry) return '';
    const match = GBP_CATEGORIES.find(
      (c) => c.toLowerCase() === industry.toLowerCase()
    );
    return match ?? '';
  }, [industry]);
  const [primaryCategory, setPrimaryCategory] = useState(prefilledPrimary);
  const [additionalCategories, setAdditionalCategories] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [newPhotoUrl, setNewPhotoUrl] = useState('');
  const [hours, setHours] = useState<Record<string, DayState>>(DEFAULT_HOURS);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAddCategory = (v: string) => {
    if (!v) return;
    if (additionalCategories.length >= 9) return;
    if (additionalCategories.includes(v)) return;
    if (v === primaryCategory) return;
    setAdditionalCategories([...additionalCategories, v]);
  };
  const onRemoveCategory = (c: string) =>
    setAdditionalCategories(additionalCategories.filter((x) => x !== c));

  const onAddPhoto = () => {
    const v = newPhotoUrl.trim();
    if (!v) return;
    if (photos.length >= 10) return;
    if (photos.includes(v)) return;
    setPhotos([...photos, v]);
    setNewPhotoUrl('');
  };
  const onRemovePhoto = (u: string) =>
    setPhotos(photos.filter((x) => x !== u));

  const updateDay = (key: string, patch: Partial<DayState>) =>
    setHours((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Convert hours state to BL's "HH:MM-HH:MM" / "closed" / "24h" format.
    const hoursPayload: Record<string, string> = {};
    for (const { key } of DAYS) {
      const d = hours[key];
      if (d.mode === 'closed') hoursPayload[key] = 'closed';
      else if (d.mode === '24h') hoursPayload[key] = '24h';
      else hoursPayload[key] = `${d.open}-${d.close}`;
    }

    const profile = {
      business_name: businessName,
      street_address: prefilledLocation.street_address,
      city: prefilledLocation.city,
      region: prefilledLocation.region,
      postcode: prefilledLocation.postcode,
      country_code: prefilledLocation.country_code,
      phone: prefilledLocation.phone,
      website: website.trim() || null,
      primary_category: primaryCategory.trim() || null,
      additional_categories:
        additionalCategories.length > 0 ? additionalCategories : null,
      description: description.trim() || null,
      hours: hoursPayload,
      photo_urls: photos.length > 0 ? photos : null,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/citations/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          location_id: locationId,
          profile,
          industry,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        order?: { id: string };
        error?: string;
        kind?: string;
        existing_order?: { id: string } | null;
      };
      if (!res.ok || !data.ok) {
        if (res.status === 409 && data.existing_order) {
          setError(
            `${data.error ?? 'open order exists'}. Open the existing order on the dashboard.`
          );
        } else {
          setError(data.error ?? `request failed (HTTP ${res.status})`);
        }
        return;
      }
      // Success — redirect to the dashboard's citations panel.
      startTransition(() =>
        router.push(`/clients/${clientPublicId}#citations`)
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Categories */}
      <Section title="Business categories" subtitle="Used by directories to classify your listing.">
        <Field label="Primary category" required help="The main thing you sell — must match a Google Business Profile category.">
          <CategoryCombobox
            value={primaryCategory}
            onChange={(v) => {
              setPrimaryCategory(v);
              // If the new primary was already in the additional list,
              // drop it from there to avoid duplicates.
              if (additionalCategories.includes(v)) {
                setAdditionalCategories(
                  additionalCategories.filter((c) => c !== v)
                );
              }
            }}
            options={GBP_CATEGORIES}
            placeholder="Select a primary category"
            required
            inputClassName={inputClass}
          />
        </Field>

        <Field label={`Additional categories (${additionalCategories.length}/9)`} help="Pick up to 9 secondary GBP categories.">
          <div className="flex flex-wrap gap-2 mb-2">
            {additionalCategories.map((c) => (
              <span
                key={c}
                className="text-xs font-mono px-2 py-1 rounded border flex items-center gap-1.5"
                style={{
                  background: 'var(--color-bg)',
                  borderColor: 'var(--color-border)',
                }}
              >
                {c}
                <button
                  type="button"
                  onClick={() => onRemoveCategory(c)}
                  className="text-zinc-500 hover:text-red-400"
                  title={`Remove ${c}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          {additionalCategories.length < 9 ? (
            <CategoryCombobox
              value=""
              onChange={onAddCategory}
              options={GBP_CATEGORIES}
              placeholder="+ Add a secondary category"
              disabledOptions={
                primaryCategory
                  ? [primaryCategory, ...additionalCategories]
                  : additionalCategories
              }
              inputClassName={inputClass}
            />
          ) : (
            <div
              className="text-[11px] text-zinc-600 font-mono px-3 py-2 rounded border"
              style={{
                background: 'var(--color-bg)',
                borderColor: 'var(--color-border)',
              }}
            >
              Max of 9 secondary categories reached.
            </div>
          )}
        </Field>
      </Section>

      {/* Description + website */}
      <Section title="Profile details">
        <Field label="Business description" required help="Plain text, ~500 chars. Avoid keyword stuffing — Google Business Profile guidelines apply across most directories.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            placeholder={`What ${businessName} does, who it serves, what makes it the right call.`}
            rows={5}
            required
            className={`${inputClass} resize-none`}
          />
          <div className="text-[11px] text-zinc-600 font-mono mt-1 text-right">
            {description.length} / 2000
          </div>
        </Field>

        <Field label="Website" help="The URL directories should send searchers to.">
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://yourbusiness.com"
            className={inputClass}
          />
        </Field>
      </Section>

      {/* Hours */}
      <Section title="Hours of operation" subtitle="Same hours go to every directory. Update here if hours change.">
        <div className="space-y-2">
          {DAYS.map(({ key, label }) => {
            const d = hours[key];
            return (
              <div
                key={key}
                className="flex items-center gap-3 text-sm"
              >
                <span className="w-10 text-zinc-400 font-mono uppercase text-xs">
                  {label}
                </span>
                <select
                  value={d.mode}
                  onChange={(e) =>
                    updateDay(key, { mode: e.target.value as DayState['mode'] })
                  }
                  className={`${inputClass} max-w-[120px]`}
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                  <option value="24h">24 hours</option>
                </select>
                {d.mode === 'open' && (
                  <>
                    <input
                      type="time"
                      value={d.open}
                      onChange={(e) => updateDay(key, { open: e.target.value })}
                      className={`${inputClass} w-[140px]`}
                      required
                    />
                    <span className="text-zinc-600">–</span>
                    <input
                      type="time"
                      value={d.close}
                      onChange={(e) => updateDay(key, { close: e.target.value })}
                      className={`${inputClass} w-[140px]`}
                      required
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Photos */}
      <Section title="Photos" subtitle="Up to 10 public URLs. Storefront, team, work-in-progress all good.">
        <Field label={`Photo URLs (${photos.length}/10)`} help="Links to publicly-accessible images. Local file uploads coming in a follow-up.">
          <div className="space-y-2 mb-2">
            {photos.map((u) => (
              <div
                key={u}
                className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded border"
                style={{
                  background: 'var(--color-bg)',
                  borderColor: 'var(--color-border)',
                }}
              >
                <span className="flex-1 truncate text-zinc-300">{u}</span>
                <button
                  type="button"
                  onClick={() => onRemovePhoto(u)}
                  className="text-zinc-500 hover:text-red-400"
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="url"
              value={newPhotoUrl}
              onChange={(e) => setNewPhotoUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onAddPhoto();
                }
              }}
              placeholder="https://..."
              className={inputClass}
              disabled={photos.length >= 10}
            />
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={onAddPhoto}
              disabled={!newPhotoUrl.trim() || photos.length >= 10}
              leftIcon={<Plus size={12} />}
            >
              Add
            </Button>
          </div>
        </Field>
      </Section>

      {/* Submit */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {error && (
          <span className="text-xs text-red-400 font-mono mr-auto max-w-md">
            {error}
          </span>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={submitting}
          loadingLabel="Submitting…"
          rightIcon={<ChevronRight size={14} />}
        >
          Submit citation order
        </Button>
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
      <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center justify-between gap-3">
        <span>
          {label}
          {required && <span className="text-zinc-600 ml-1">*</span>}
        </span>
        {help && (
          <span className="text-[10px] normal-case tracking-normal text-zinc-600 max-w-md text-right">
            {help}
          </span>
        )}
      </label>
      {children}
    </div>
  );
}
