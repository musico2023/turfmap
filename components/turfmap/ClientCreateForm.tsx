'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Check, ChevronRight, MapPin, X } from 'lucide-react';
import { extractPostcodeFromAddress } from '@/lib/geocoding/parsePostcode';
import { Button } from '@/components/ui/Button';
import { InfoTooltip } from './InfoTooltip';
import {
  AddressAutocomplete,
  type AddressFields,
} from './AddressAutocomplete';

// Grouped industry options for the <select>. Each group corresponds
// to a BrightLocal directory profile (lib/brightlocal/directories.ts):
// home-services, medical-healthcare, legal, food-restaurant,
// real-estate, automotive. Within a group, every option string
// matches the BL inference regex and routes to the same profile —
// so the granular value (e.g. "hvac" vs "plumbing") survives in
// AI Coach prompts but the NAP audit fires the right directory set
// regardless of pick.
//
// Closed set, no free-text. Operators previously typed unsupported
// categories (e.g. "desserts") that silently fell back to home-
// services. The <select> makes that impossible — every choice
// produces a correct audit.
type IndustryGroup = {
  label: string;
  options: string[];
};

const INDUSTRY_GROUPS: IndustryGroup[] = [
  {
    label: 'Home services',
    options: [
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
    ],
  },
  {
    label: 'Medical & healthcare',
    options: [
      'medical',
      'dental',
      'chiropractic',
      'veterinary',
      'pediatric',
      'optometry',
      'physical therapy',
      'home healthcare',
    ],
  },
  {
    label: 'Legal',
    options: ['law firm', 'attorney'],
  },
  {
    label: 'Food & restaurant',
    // Note: "dessert cafe" / "ice cream parlor" buyers should pick
    // 'cafe' or 'bakery' — the BL regex matches those tokens and
    // routes to the food-restaurant profile (TripAdvisor, OpenTable,
    // Foursquare, Zomato, DoorDash, Grubhub).
    options: ['restaurant', 'cafe', 'bakery', 'catering', 'pizza'],
  },
  {
    label: 'Real estate',
    options: ['real estate', 'realtor'],
  },
  {
    label: 'Automotive',
    options: ['auto repair', 'auto body', 'car wash', 'detailing'],
  },
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
  keyword: string;
  scan_frequency: 'weekly' | 'biweekly' | 'monthly' | 'daily';
  /** Plan selector at create time. 'agency_managed' = billed
   *  outside Stripe (your custom contract). 'pulse' / 'pulse_plus' =
   *  generates a Stripe Checkout link (with trial) the operator
   *  forwards to the buyer; the row is parked as
   *  self_serve_subscription with stripe_subscription_id null
   *  until the buyer completes Checkout. */
  plan: 'agency_managed' | 'pulse' | 'pulse_plus';
  /** Tier visible only when plan=agency_managed. Determines feature
   *  gates immediately on row create — no Stripe webhook to set it. */
  tier_for_agency: 'pulse' | 'pulse_plus';
  /** Trial length for the Stripe Checkout flow (Pulse / Pulse+
   *  plans only). 0 = no trial. */
  trial_days: '0' | '7' | '14' | '30';
  /** Buyer email — separate from the operator's auth email. Used to
   *  pre-fill Stripe Checkout's customer_email so the buyer doesn't
   *  retype. Required for Stripe plans, ignored for agency-managed. */
  buyer_email: string;
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
  keyword: '',
  scan_frequency: 'weekly',
  plan: 'agency_managed',
  tier_for_agency: 'pulse_plus',
  trial_days: '14',
  buyer_email: '',
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

  // Post-create state for the Stripe-plan path. When the API returns
  // a checkout_url, we surface it in a dedicated success state so
  // the operator can copy/forward it to the buyer instead of being
  // redirected straight to the dashboard.
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [createdPublicId, setCreatedPublicId] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

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

    // Validate buyer email when on a Stripe plan — server also
    // validates, but cheap client-side sanity check first.
    if (
      (form.plan === 'pulse' || form.plan === 'pulse_plus') &&
      !form.buyer_email.trim()
    ) {
      setError('Buyer email is required for Pulse / Pulse+ plans.');
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
      // primary_color intentionally omitted — the API defaults it to
      // '#c5ff3a' server-side, matching the logo-only white-label
      // policy. The picker was removed so operators can't override
      // back to a clashing hex.
      keyword: {
        keyword: form.keyword.trim(),
        scan_frequency: form.scan_frequency,
        is_primary: true,
      },
      // Plan + billing fields — drive billing_mode + tier on the
      // new row, and (for Stripe plans) tell the API to generate a
      // Checkout link.
      plan: form.plan,
      ...(form.plan === 'agency_managed'
        ? { tier: form.tier_for_agency }
        : {
            tier: form.plan,
            buyer_email: form.buyer_email.trim(),
            trial_days: Number(form.trial_days),
          }),
    };
    if (form.industry) body.industry = form.industry;

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
        /** Set when plan was 'pulse' or 'pulse_plus'. Operator
         *  forwards this to the buyer to start the trial / charge. */
        checkout_url?: string | null;
      };
      if (!res.ok || !data.id) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      const slug = data.public_id ?? data.id;
      // Stripe-plan path: surface the Checkout URL in a success
      // state instead of redirecting. Operator copies + sends to
      // the buyer; the buyer then completes Checkout, which fires
      // the webhook and activates the row.
      if (data.checkout_url) {
        setCheckoutUrl(data.checkout_url);
        setCreatedPublicId(slug);
        setSubmitting(false);
        return;
      }
      // Agency-managed path: redirect straight to the dashboard,
      // since there's no buyer interaction needed before the row is
      // fully usable.
      startTransition(() => router.push(`/clients/${slug}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  // Post-Stripe-create success state. Renders instead of the form
  // when the operator just created a Stripe-plan client and we
  // got back a Checkout URL. Replaces the usual redirect-to-
  // dashboard so the operator can grab the link.
  if (checkoutUrl && createdPublicId) {
    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(checkoutUrl);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2500);
      } catch {
        // Clipboard API can fail on http (non-localhost). Fall back
        // to selecting the text — operator can copy manually.
      }
    };
    return (
      <div
        className="border rounded-lg p-6 max-w-3xl space-y-4"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <div>
          <h3 className="font-display text-lg font-bold">
            Client created — payment setup pending
          </h3>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
            The client row exists and is ready for scans. Forward the
            Stripe Checkout link below to the buyer to start their
            trial and capture payment.
          </p>
        </div>

        <div
          className="rounded-md border px-3 py-3 font-mono text-xs break-all"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
            color: '#e4e4e7',
          }}
        >
          {checkoutUrl}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={onCopy}
          >
            {linkCopied ? '✓ Link copied' : 'Copy link'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={() => router.push(`/clients/${createdPublicId}`)}
          >
            Go to dashboard
          </Button>
        </div>

        <p className="text-[11px] text-zinc-600 leading-relaxed">
          Once the buyer completes Checkout, the Stripe webhook
          activates the row automatically — no further action
          needed on your end. If the link expires (24h Stripe
          default) or the buyer abandons, regenerate from the
          client&rsquo;s settings page.
        </p>
      </div>
    );
  }

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
        <Field
          label="Address"
          required
          help="Start typing — pick from the dropdown to auto-fill the structured NAP fields below."
        >
          <AddressAutocomplete
            value={form.address}
            onChange={(next) => update('address', next)}
            onSelect={(fields: AddressFields) => {
              // Operator picked a Mapbox suggestion — populate the
              // structured NAP fields + lat/lng directly. Skips the
              // /api/geocode round-trip for selected results; the
              // existing debounced geocode still runs as a fallback
              // for typed-but-not-selected addresses.
              update('address', fields.formatted);
              update('street_address', fields.street_address);
              update('city', fields.city);
              update('region', fields.region);
              update('postcode', fields.postcode);
              update(
                'country_code',
                fields.country_code.toUpperCase() === 'CA'
                  ? 'CAN'
                  : fields.country_code.toUpperCase() === 'US'
                    ? 'USA'
                    : fields.country_code.toUpperCase()
              );
              update('latitude', String(fields.latitude));
              update('longitude', String(fields.longitude));
              setGeocode({
                status: 'found',
                lat: fields.latitude,
                lng: fields.longitude,
                formatted: fields.formatted,
              });
            }}
            placeholder="100 Queen St W, Toronto"
            required
            inputClassName={inputClass}
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
          <Field
            label="Industry"
            tooltip={
              <>
                Drives which directories the NAP audit checks
                (Healthgrades for medical, OpenTable for restaurants,
                Angi for home services, etc.) and tunes the AI Coach
                recommendations to your category. Closed list — every
                option routes cleanly to a known directory profile.
              </>
            }
          >
            <select
              value={form.industry}
              onChange={(e) => update('industry', e.target.value)}
              className={inputClass}
            >
              <option value="">— Select an industry —</option>
              {INDUSTRY_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
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

      {/* Plan — replaces the old Billing > Monthly Price section.
       *  Decides whether the row is created as agency_managed (your
       *  custom contract, billed outside Stripe) or routed through
       *  Stripe with a trial-then-charge subscription. The
       *  monthly_price_cents column still exists for record-
       *  keeping and is editable from /clients/[id]/settings.
       *
       *  Logo upload is also handled in /clients/[id]/settings
       *  (LogoUploader needs the client UUID for the storage path).
       *  Brand-accent color was removed entirely: every portal
       *  renders with the standard TurfMap lime + dark surfaces
       *  with only the logo varying per client. */}
      <Section
        title="Plan"
        subtitle="Drives feature gates immediately + decides whether to bill via Stripe or your agency contract."
      >
        <Field label="Plan type">
          <select
            value={form.plan}
            onChange={(e) =>
              update('plan', e.target.value as Form['plan'])
            }
            className={inputClass}
          >
            <option value="agency_managed">
              Agency-managed — billed outside Stripe
            </option>
            <option value="pulse">Pulse — Stripe subscription</option>
            <option value="pulse_plus">Pulse+ — Stripe subscription</option>
          </select>
        </Field>

        {form.plan === 'agency_managed' && (
          <Field
            label="Tier under agency contract"
            help="Drives feature gates (citations, exports, granular alerts, keyword caps). Most agency contracts bundle Pulse+."
          >
            <select
              value={form.tier_for_agency}
              onChange={(e) =>
                update(
                  'tier_for_agency',
                  e.target.value as Form['tier_for_agency']
                )
              }
              className={inputClass}
            >
              <option value="pulse_plus">Pulse+</option>
              <option value="pulse">Pulse</option>
            </select>
          </Field>
        )}

        {(form.plan === 'pulse' || form.plan === 'pulse_plus') && (
          <>
            <Field
              label="Buyer email"
              required
              help="Pre-fills Stripe Checkout. Separate from your operator email."
            >
              <input
                type="email"
                value={form.buyer_email}
                onChange={(e) => update('buyer_email', e.target.value)}
                placeholder="owner@business.com"
                required
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field
              label="Trial length"
              help="Stripe charges the card on file when the trial ends. 0 = bill immediately."
            >
              <select
                value={form.trial_days}
                onChange={(e) =>
                  update('trial_days', e.target.value as Form['trial_days'])
                }
                className={inputClass}
              >
                <option value="14">14 days (default)</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="0">No trial — bill immediately</option>
              </select>
            </Field>
            <div
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                background: 'rgba(255, 159, 58, 0.05)',
                borderColor: 'rgba(255, 159, 58, 0.3)',
                color: '#ffb86b',
              }}
            >
              After save, you&rsquo;ll get a Stripe Checkout link to
              forward to the buyer. The client row stays in
              &ldquo;awaiting payment setup&rdquo; until they complete
              checkout — at which point the trial begins and the row
              activates automatically via webhook.
            </div>
          </>
        )}
      </Section>

      {/* Actions */}
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
          disabled={geocode.status === 'looking'}
          loading={submitting}
          loadingLabel="Creating…"
          rightIcon={<ChevronRight size={14} />}
        >
          Create client
        </Button>
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
          // `flex` (not inline-flex) + `min-w-0` on the row so the
          // truncate target inherits a real bounded width. Long
          // Nominatim-normalized addresses (e.g. "1440 Bathurst Street,
          // The Annex, Toronto, Old Toronto, Ontario, M5R 3J3, Canada")
          // were overflowing past the parent into the override-coords
          // toggle button on the right. Pre-fix the inline-flex didn't
          // establish a width context for `truncate`.
          <span className="flex items-start gap-1.5 text-zinc-300 min-w-0">
            <Check
              size={12}
              className="flex-shrink-0 mt-0.5"
              style={{ color: 'var(--color-lime)' }}
            />
            <span className="truncate min-w-0 flex-1">
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
  tooltip,
  children,
}: {
  label: string;
  required?: boolean;
  /** Short inline note rendered to the right of the label. Use for
   *  one-liner format hints ("E.164 preferred", "Skip the postal
   *  code"). Anything longer than ~50 chars overflows the row —
   *  use `tooltip` instead for longer explanations. */
  help?: React.ReactNode;
  /** Longer explanation surfaced via an (i) icon next to the label.
   *  Use for "what does this field do" copy that doesn't fit
   *  inline. Renders the same InfoTooltip pattern used on the
   *  dashboard score cards. */
  tooltip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          {label}
          {required && <span className="text-zinc-600 ml-1">*</span>}
          {tooltip && <InfoTooltip>{tooltip}</InfoTooltip>}
        </span>
        {help && <span className="text-[10px] normal-case tracking-normal">{help}</span>}
      </label>
      {children}
    </div>
  );
}
