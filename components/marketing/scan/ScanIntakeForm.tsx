'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle, Lock, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { trackMetaEvent, readCookie } from '@/components/marketing/scan/MetaPixel';
import {
  AddressAutocomplete,
  type AddressFields,
} from '@/components/turfmap/AddressAutocomplete';
import { TurnstileWidget } from '@/components/security/TurnstileWidget';
import { ScanProgress } from '@/components/turfmap/ScanProgress';

/**
 * Intake form for the /scan cold-Meta intake-first flow.
 *
 * Collects business details BEFORE Stripe so:
 *   - Buyer invests effort while motivated (less post-payment intake
 *     abandonment than the legacy Stripe-first flow on /fourdots).
 *   - All intake fields land on the Stripe session metadata so
 *     /order/success can fulfill the scan immediately on return —
 *     no second form, no "wait while we ask for details" interstitial.
 *
 * On submit:
 *   1. POST /api/scan/checkout/init with the form + URL attribution
 *   2. Fire Meta InitiateCheckout (the brief's Stripe-start signal)
 *   3. Redirect the browser to the returned Stripe Checkout URL
 *
 * Fields mirror what /api/orders/fulfill expects on the legacy path:
 * businessName, address, keyword (single, scan tier), email, phone.
 * Validation client-side is intentionally loose — server-side Zod is
 * the source of truth.
 */

export type ScanIntakeFormProps = {
  /** Which tier the buyer is purchasing. Drives the Stripe price the
   *  init route picks + the number of keyword inputs that render +
   *  the page-level copy. Defaults to 'scan' so legacy callers that
   *  don't pass a tier still work.
   *
   *  'strategy' + 'pulse_plus' render THREE keyword inputs (the
   *  buyer is buying the 3-keyword comparative scan / 3-keyword
   *  Pulse+ subscription). 'scan' / 'audit' / 'pulse' render one. */
  tier?: 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';
  /** Subscription billing cadence — required for pulse / pulse_plus,
   *  ignored for one-shot tiers. Forwarded to the init endpoint so
   *  it can resolve the correct Stripe Price + decide whether to
   *  append the $99 TurfScan setup fee (monthly only). */
  cadence?: 'monthly' | 'annual' | null;
  // Attribution params forwarded from the upstream lander via /intake
  // URL → carried into the init endpoint → stamped onto Stripe metadata.
  // Each independently optional.
  coupon?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  gclid?: string | null;
  /** Meta click id auto-appended by Facebook/Instagram to ad
   *  destinations. Forwarded to Stripe metadata for downstream
   *  Conversion API deduplication. */
  fbclid?: string | null;
  /** Cold/warm cohort prospect id. Forwarded to the init endpoint so
   *  the Stripe session metadata carries prospect_id for downstream
   *  conversion stamping on prospects.converted_at. */
  prospectId?: string | null;
  /** Resolved final price in cents (after coupon). Drives the button
   *  label + helper copy so a $0 (VIP) buyer sees "Continue to free
   *  checkout" instead of "Continue to secure checkout — $49". */
  finalCents?: number | null;
  /** Pre-filled business name from prospects lookup (warm/cold cohort). */
  prefillBusinessName?: string | null;
  /** Pre-filled keyword from prospects.trade. */
  prefillKeyword?: string | null;
  /** When true, the form acts as the /score lead-magnet preview
   *  entry. POSTs to /api/score/preview-init instead of
   *  /api/scan/checkout/init, swaps the button copy + helper text
   *  for the free-score frame, and redirects directly to /share/<id>
   *  instead of Stripe Checkout. Always 1 keyword regardless of
   *  `tier`. */
  previewMode?: boolean;
  /** Lander-level identifier — forwarded to /api/score/preview-init
   *  in the POST body as `lead_source`, then stamped on the
   *  lead_orders row so unlock-init can decide whether to discount
   *  the unlock. Known slugs:
   *    - 'score'       → homepage's free-TurfScore CTA → $99 unlock
   *    - 'free_score'  → cold-Meta /free-score lander → $49 unlock
   *  Ignored outside previewMode. */
  leadSource?: string | null;
};

export function ScanIntakeForm({
  tier = 'scan',
  cadence = null,
  coupon = null,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  utmTerm,
  gclid,
  fbclid,
  prospectId = null,
  finalCents = null,
  prefillBusinessName = null,
  prefillKeyword = null,
  previewMode = false,
  leadSource = null,
}: ScanIntakeFormProps) {
  const [businessName, setBusinessName] = useState(prefillBusinessName ?? '');
  const [address, setAddress] = useState('');
  // Mapbox-picked address record. Set when the buyer chooses from the
  // autocomplete dropdown; cleared if they subsequently edit the text
  // (so a stale pick can't override their fresh typing). Carries
  // lat/lng + structured components that we forward to /api/scan/
  // checkout/init so the downstream fulfill route can skip Nominatim
  // entirely for picked addresses — that's the address path that
  // produced the Hendricks / Meadowview wrong-city matches before.
  const [selected, setSelected] = useState<AddressFields | null>(null);
  // Strategy + Pulse+ = 3 keywords (comparative scan + 3-keyword
  // subscription); scan / audit / pulse = 1. Preview mode always
  // collects 1 — the free score targets one primary keyword, the
  // tier dimension only matters post-unlock. State is always a
  // string[]; the first slot uses the prefill, the rest start blank.
  // Length is fixed at mount-time so field rendering stays stable
  // across re-renders.
  const keywordSlotCount = previewMode
    ? 1
    : tier === 'strategy' || tier === 'pulse_plus'
      ? 3
      : 1;
  const [keywords, setKeywords] = useState<string[]>(() => {
    const arr = Array(keywordSlotCount).fill('');
    arr[0] = prefillKeyword ?? '';
    return arr;
  });
  const setKeywordAt = (idx: number, value: string) => {
    setKeywords((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cloudflare Turnstile token (preview mode only). Stays an empty
  // string until the widget calls back with a solved challenge — or
  // permanently empty if NEXT_PUBLIC_TURNSTILE_SITEKEY isn't
  // configured (widget short-circuits, backend mirrors). Empty
  // string is a valid send value; backend interprets it as
  // "skipped" when the secret env var is also unset.
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY ?? '';

  // Submit is blocked while a Mapbox pick isn't locked in. The buyer
  // MUST select from the dropdown — free-text fallback (Nominatim
  // geocoding) is the path that produced wrong-city matches before
  // (Hendricks Behavioral Hospital 2026-05-19), so we removed it.
  // Same predicate that gates the submit handler — exposed up here so
  // the button + visual chip can mirror its state.
  const trimmedAddress = address.trim();
  const addressPicked = !!(
    selected &&
    (selected.formatted === trimmedAddress ||
      selected.street_address === trimmedAddress)
  );

  // Lightweight "form looks filled" predicate — gates when the
  // Turnstile widget is rendered in previewMode. We don't validate
  // exhaustively here (server-side Zod is the source of truth), just
  // check each field is plausibly populated so the widget doesn't
  // appear until the buyer is ready to submit. Mirrors the spirit
  // of HTML's `:valid` selector but doesn't depend on the browser's
  // built-in form validation API (which behaves inconsistently
  // across Safari/Firefox/Chrome).
  const allFieldsLookFilled =
    businessName.trim().length >= 2 &&
    addressPicked &&
    keywords.every((k) => k.trim().length >= 2) &&
    email.includes('@') &&
    email.length >= 5 &&
    phone.trim().length >= 7;

  // The Turnstile widget renders only when (a) we're in previewMode,
  // (b) the site key is configured, and (c) every other field looks
  // filled — so the buyer's first impression of the form is a clean
  // 5-input panel without a bot-check waiting at the bottom. Once
  // all fields are populated, the widget slots in and the submit
  // button stays disabled until the token resolves.
  const shouldRenderTurnstile =
    previewMode && !!turnstileSiteKey && allFieldsLookFilled;

  // Submit gate for previewMode: the existing addressPicked gate is
  // augmented by "Turnstile has either passed (token present) OR is
  // disabled by config (no site key set)". Outside previewMode this
  // collapses to true (Turnstile isn't enabled for the paid flows
  // since they're card-gated anyway).
  const turnstileReady =
    !previewMode || !turnstileSiteKey || !!turnstileToken;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);

    // Hard gate — buyer must pick from the Mapbox dropdown. We don't
    // accept freeform addresses anymore because the input field only
    // ever shows the street line after Mapbox's autofill rewrite, so
    // buyers can't visually verify which Toronto/Plainfield/etc the
    // Mapbox match locked onto. Forcing a pick keeps lat/lng + the
    // structured components anchored to a known-good Mapbox result.
    if (!addressPicked) {
      setError(
        'Please pick your business address from the dropdown — typing freely won\'t lock the right location for your scan.'
      );
      // Don't fire InitiateCheckout — this isn't a checkout start yet.
      return;
    }

    // Strategy + Pulse+ buyers need all 3 keyword slots filled.
    // Scan / audit / pulse only need 1 (the required attribute on
    // the input already gates, but we double-check here so a
    // JS-tampered submit can't bypass).
    const trimmedKeywords = keywords.map((k) => k.trim()).filter(Boolean);
    if (trimmedKeywords.length !== keywordSlotCount) {
      const noun =
        tier === 'strategy'
          ? 'Strategy Session comparison'
          : tier === 'pulse_plus'
            ? 'Pulse+ 3-keyword subscription'
            : 'comparison';
      setError(
        keywordSlotCount === 1
          ? 'Keyword is required.'
          : `All ${keywordSlotCount} keywords are required for the ${noun}.`
      );
      return;
    }

    setLoading(true);

    // Meta CAPI dedup id — generated once here, sent to BOTH the
    // server (so /api/score/preview-init fires Lead via CAPI) and to
    // the client-side fbq call below. Facebook dedupes the pair on
    // event_name + event_id, so both surfaces can fire safely without
    // double-counting in attribution.
    //
    // crypto.randomUUID requires a secure context — all our landers
    // are served HTTPS in prod and localhost is allow-listed by
    // browsers, so this is safe. Fallback to Date.now()+random would
    // weaken dedup so we just skip the eventId on rare unsupported
    // browsers (Facebook then counts pixel-only).
    const metaEventId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : undefined;

    // _fbp + _fbc cookies (set by the Meta pixel). Sent server-side so
    // CAPI's user_data match-quality stays high. Both can be null —
    // CAPI tolerates partial user_data and Facebook still tries to
    // match on email/phone/IP.
    const fbpCookie = readCookie('_fbp');
    const fbcCookie = readCookie('_fbc');

    // Paid intake fires InitiateCheckout on submit (intent signal).
    // Preview mode defers the Lead event to the success branch
    // (post-fetch) so a failed scan doesn't orphan a Lead event in
    // Facebook attribution.
    if (!previewMode) {
      const valueDollars =
        finalCents != null ? finalCents / 100 : 49;
      trackMetaEvent('InitiateCheckout', {
        currency: 'USD',
        value: valueDollars,
        content_name: 'TurfScan',
        content_category: 'scan_intake_submit',
        coupon: coupon ?? undefined,
        utm_source: utmSource ?? undefined,
        utm_medium: utmMedium ?? undefined,
        utm_campaign: utmCampaign ?? undefined,
      });
    }

    try {
      // Forward the Mapbox pick — guaranteed non-null by the
      // addressPicked gate above. lat/lng + structured components
      // flow end-to-end so the downstream route skips Nominatim
      // entirely (whether that's /api/orders/fulfill on the paid
      // path, or createPreviewClient on the preview path).
      const picked = selected;
      const endpoint = previewMode
        ? '/api/score/preview-init'
        : '/api/scan/checkout/init';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tier,
          // Only send cadence when defined — subscription tiers
          // depend on it; one-shot tiers ignore the field entirely
          // server-side (the Zod schema defaults to 'monthly').
          ...(cadence ? { cadence } : {}),
          // Cloudflare Turnstile token (preview mode only). Backend
          // skips verification when both sides are unconfigured;
          // when site key IS set client-side, this carries the
          // solved-challenge token to the server-side verifier.
          ...(previewMode && turnstileToken
            ? { turnstile_token: turnstileToken }
            : {}),
          // Lander identifier — only forwarded in previewMode, where
          // unlock-init reads it to decide $99 vs $49 (MAPCHECK50).
          // Paid intake doesn't need it (the upstream lander already
          // picked the coupon).
          ...(previewMode && leadSource ? { lead_source: leadSource } : {}),
          // Meta CAPI dedup payload — preview path only. Server uses
          // these to fire a deduped Lead event via the Conversions
          // API so Facebook sees the conversion even when the pixel
          // is blocked (iOS 14+ ATT, ad blockers, etc.).
          ...(previewMode && metaEventId
            ? { meta_event_id: metaEventId }
            : {}),
          ...(previewMode && fbpCookie ? { fbp_cookie: fbpCookie } : {}),
          ...(previewMode && fbcCookie ? { fbc_cookie: fbcCookie } : {}),
          ...(previewMode && typeof window !== 'undefined'
            ? { event_source_url: window.location.href }
            : {}),
          businessName: businessName.trim(),
          address: address.trim(),
          // Always send keywords as an array — server validates the
          // count against the tier (1 for scan/audit/pulse, 3 for
          // strategy/pulse_plus). Also send `keyword` (first element)
          // for back-compat with any caller that still inspects the
          // singular field.
          keyword: trimmedKeywords[0],
          keywords: trimmedKeywords,
          email: email.trim(),
          phone: phone.trim(),
          coupon: coupon ?? undefined,
          utm_source: utmSource ?? undefined,
          utm_medium: utmMedium ?? undefined,
          utm_campaign: utmCampaign ?? undefined,
          utm_content: utmContent ?? undefined,
          utm_term: utmTerm ?? undefined,
          gclid: gclid ?? undefined,
          fbclid: fbclid ?? undefined,
          prospect_id: prospectId ?? undefined,
          latitude: picked?.latitude,
          longitude: picked?.longitude,
          components: picked
            ? {
                street_address: picked.street_address,
                city: picked.city,
                region: picked.region,
                postcode: picked.postcode,
                country_code: picked.country_code,
              }
            : undefined,
        }),
      });
      // Paid path returns { url } (Stripe Checkout URL); preview
      // path returns { share_url } (the in-app /share/<id> route).
      // Both are absolute or root-relative URLs the browser can
      // hard-navigate to.
      const data = (await res.json()) as {
        url?: string;
        share_url?: string;
        error?: string;
      };
      const destination = previewMode ? data.share_url : data.url;
      if (!res.ok || !destination) {
        setError(
          data.error ??
            (previewMode
              ? "We couldn't run your free scan right now. Try again, or email hello@turfmap.ai."
              : "We couldn't open Stripe Checkout. Try again, or email hello@turfmap.ai.")
        );
        setLoading(false);
        return;
      }
      // Preview-mode success — fire the client-side Lead event NOW
      // (post-success, so a failed scan doesn't orphan an attribution
      // signal). Tagged with the same metaEventId we sent to the
      // server, so Facebook dedupes against the CAPI Lead the server
      // just kicked off in after().
      if (previewMode) {
        trackMetaEvent(
          'Lead',
          {
            content_name: 'TurfScore Free Preview',
            content_category: 'score_preview_submit',
            utm_source: utmSource ?? undefined,
            utm_medium: utmMedium ?? undefined,
            utm_campaign: utmCampaign ?? undefined,
            ...(leadSource ? { lead_source: leadSource } : {}),
          },
          metaEventId ? { eventID: metaEventId } : undefined
        );
      }
      // Hard navigation — Stripe Checkout is cross-origin, and even
      // the in-app share-page redirect benefits from a full nav so
      // the server component renders fresh with the new scan.
      window.location.assign(destination);
    } catch (err) {
      setLoading(false);
      setError(
        err instanceof Error
          ? `Network error: ${err.message}`
          : previewMode
            ? "We couldn't reach our scan service. Try again, or email hello@turfmap.ai."
            : "We couldn't reach Stripe. Try again, or email hello@turfmap.ai."
      );
    }
  };

  return (
    <>
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        label="Business name"
        id="biz-name"
        value={businessName}
        onChange={setBusinessName}
        placeholder="e.g. Acme Plumbing"
        autoComplete="organization"
        required
      />
      {/* Address — special-cased: Mapbox AddressAutofill instead of
       *  the plain Field component. Picking from the dropdown writes
       *  the canonical formatted address back into state so the
       *  downstream Stripe + fulfill steps geocode against a known-
       *  good string. Free typing still works (degrades gracefully)
       *  if NEXT_PUBLIC_MAPBOX_TOKEN is unset or Mapbox doesn't have
       *  a match. */}
      <AddressFieldWithAutocomplete
        value={address}
        picked={addressPicked ? selected : null}
        onChange={(next) => {
          setAddress(next);
          // Clear the Mapbox pick only when the buyer TYPES something
          // that doesn't match what they previously picked. Mapbox's
          // AddressAutofill writes street_address ("1051 Southfield
          // Drive") to the input AFTER our onSelect fires (which set
          // address = formatted "...Plainfield, Indiana 46168..."),
          // triggering this onChange with the shorter string — that
          // is NOT a real edit, just Mapbox's post-pick canonicalize.
          // Tolerating both `formatted` and `street_address` keeps
          // the pick alive across that auto-rewrite so the submit
          // forwards the coords end-to-end.
          if (
            selected &&
            next !== selected.formatted &&
            next !== selected.street_address
          ) {
            setSelected(null);
          }
        }}
        onSelect={(fields: AddressFields) => {
          setAddress(fields.formatted);
          setSelected(fields);
          // Clear any prior "please pick from dropdown" gate error
          // now that the buyer has picked. Other errors (network /
          // Stripe) stay surfaced until the next submit.
          setError(null);
        }}
      />
      {keywordSlotCount === 1 ? (
        <Field
          label="Keyword to scan"
          id="biz-keyword"
          value={keywords[0] ?? ''}
          onChange={(v) => setKeywordAt(0, v)}
          placeholder='e.g. "plumber toronto" or "ac repair calgary"'
          required
          hint="The search your highest-value customers actually type. Not your business name — what someone searching for what you do would enter."
        />
      ) : (
        // Strategy: 3 keywords. We frame as a primary + two service
        // angles so the buyer understands what each slot is for — the
        // comparative analysis on the strategist call leans on
        // contrasts between these three picks (which keyword has
        // the most opportunity, which is most contested, etc.).
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] uppercase tracking-[0.18em] text-zinc-400 font-mono font-semibold mb-1.5">
              Keywords to compare
              <span className="ml-1 text-zinc-600" aria-hidden="true">
                *
              </span>
            </label>
            <p className="text-[11px] text-zinc-500 leading-relaxed mb-2">
              Three searches your highest-value customers type. Pick
              your primary first, then two adjacent service angles or
              variations — we&apos;ll run all three in parallel and
              show how your visibility differs between them.
            </p>
          </div>
          {[0, 1, 2].map((i) => (
            <Field
              key={i}
              label={
                i === 0
                  ? 'Primary keyword'
                  : i === 1
                    ? 'Service angle #2'
                    : 'Service angle #3'
              }
              id={`biz-keyword-${i}`}
              value={keywords[i] ?? ''}
              onChange={(v) => setKeywordAt(i, v)}
              placeholder={
                i === 0
                  ? '"plumber toronto"'
                  : i === 1
                    ? '"drain cleaning toronto"'
                    : '"water heater repair toronto"'
              }
              required
            />
          ))}
        </div>
      )}
      <Field
        label="Email"
        id="biz-email"
        type="email"
        value={email}
        onChange={setEmail}
        placeholder="you@business.com"
        autoComplete="email"
        required
        hint="Where we send your report + receipt."
      />
      <Field
        label="Business phone"
        id="biz-phone"
        type="tel"
        value={phone}
        onChange={setPhone}
        placeholder="(416) 555-1234"
        autoComplete="tel"
        required
        hint="The number your business publishes on Google + directories. Not your personal cell."
      />

      {/* Cloudflare Turnstile — bot-protection check on the free
       *  /score flow. Only renders in previewMode AND after every
       *  field looks filled (allFieldsLookFilled gate above). This
       *  keeps the initial form clean — visitors see 5 inputs +
       *  the submit button, not a security widget sitting idle
       *  waiting for them to fill the form. The widget slots in at
       *  the moment the buyer is ready to submit, and the submit
       *  button stays disabled until its token arrives. When
       *  NEXT_PUBLIC_TURNSTILE_SITEKEY isn't set, the widget
       *  short-circuits to nothing and the backend skips
       *  verification too. */}
      {shouldRenderTurnstile ? (
        <div className="pt-1">
          <p className="text-[11px] uppercase tracking-[0.18em] font-mono text-zinc-500 mb-1.5">
            Quick bot check
          </p>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onToken={setTurnstileToken}
          />
        </div>
      ) : null}

      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={loading}
          loadingLabel={
            previewMode
              ? 'Running your free scan…'
              : finalCents === 0
                ? 'Confirming your free scan…'
                : 'Opening secure checkout…'
          }
          rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
          // Disabled until the buyer picks an address from the
          // Mapbox dropdown AND (in previewMode with Turnstile
          // configured) the bot-check token has resolved. Avoids
          // click-then-error round-trips on the two most common
          // rejection reasons. The submit handler still has its
          // own gates as defense-in-depth (Enter key, JS-disabled
          // native submit, etc.).
          disabled={!addressPicked || !turnstileReady}
        >
          {previewMode
            ? 'Get my free TurfScore'
            : finalCents === 0
              ? 'Continue — free with code'
              : finalCents != null
                ? `Continue to secure checkout — $${finalCents / 100}`
                : 'Continue to secure checkout'}
        </Button>
        <p className="mt-3 text-xs text-zinc-500 leading-relaxed flex items-center gap-1.5">
          <Lock size={11} className="text-zinc-600" />
          {previewMode ? (
            <>
              No card. No charge. We&rsquo;ll run the 81-point scan and
              show you your TurfScore in under a minute.
            </>
          ) : finalCents === 0 ? (
            <>
              {coupon ?? 'Discount'} applied — no card charged. Scan fires the
              moment we confirm.
            </>
          ) : (
            <>
              {coupon ? `${coupon} auto-applied at checkout. ` : ''}Stripe
              charges{' '}
              {finalCents != null ? `$${finalCents / 100}` : 'the listed price'}{' '}
              once. No subscription, refund within 24h.
            </>
          )}
        </p>
        {error && (
          <p
            className="mt-3 text-xs leading-relaxed flex items-start gap-1.5"
            style={{ color: '#f5b651' }}
            role="alert"
          >
            <AlertCircle
              size={13}
              strokeWidth={2.25}
              className="flex-shrink-0 mt-0.5"
            />
            <span>{error}</span>
          </p>
        )}
      </div>
    </form>
    {/* Full-screen scan-progress overlay — previewMode only.
     *  The preview-init scan runs synchronously for 30-90s; without
     *  this overlay the buyer stares at a near-static "Running your
     *  free scan…" button label and the page reads as frozen. The
     *  overlay renders the same ScanProgress component the cold-
     *  email COLDSCAN flow uses, with rotating status phrases
     *  ("Mapping 81 search points…" → "Querying the local 3-pack
     *  at each grid point…" → "Almost there…") so the buyer sees
     *  visible motion + understands roughly what the system is
     *  doing while it works.
     *
     *  Paid flows (intake → Stripe Checkout redirect) don't get
     *  this overlay — their loading state is short (~2-3s to open
     *  Stripe) and the existing button label suffices. */}
    {previewMode && loading && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center px-6"
        style={{ background: 'rgba(10, 10, 10, 0.94)' }}
        aria-live="polite"
        aria-busy="true"
      >
        <div className="max-w-md w-full">
          <ScanProgress />
        </div>
      </div>
    )}
    </>
  );
}

// ─── Single labeled input ───────────────────────────────────────────────

function Field({
  label,
  id,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  required = false,
  hint,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] uppercase tracking-[0.18em] text-zinc-400 font-mono font-semibold mb-1.5"
      >
        {label}
        {required && (
          <span className="ml-1 text-zinc-600" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="w-full rounded-md border text-zinc-100 text-base placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-lime-400/40 px-3.5 py-3 transition-colors"
        style={{
          background: '#0d0d10',
          borderColor: 'var(--color-border)',
        }}
      />
      {hint && (
        <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}

// ─── Business-address input with Mapbox autocomplete ─────────────────
// Wraps the shared <AddressAutocomplete> in the same label + hint
// shell as <Field /> so it sits flush in the form's typographic rhythm.
// The address is the most pivotal field (drives the 9x9 scan grid +
// downstream NAP audit + GBP enrichment), so a suggestion dropdown is
// worth the extra render complexity over the bare HTML5 input.
//
// Mapbox token is read inside AddressAutocomplete from
// process.env.NEXT_PUBLIC_MAPBOX_TOKEN; if unset the component
// degrades to a plain input (no dropdown). US + CA are the default
// suggestion universe — matches our service area.

function AddressFieldWithAutocomplete({
  value,
  picked,
  onChange,
  onSelect,
}: {
  value: string;
  /** Non-null when the buyer has chosen a Mapbox dropdown entry AND
   *  the input text still matches that pick (either the full
   *  formatted form OR the street-only form Mapbox autofills back).
   *  Drives the confirmation chip below the input. */
  picked: AddressFields | null;
  onChange: (next: string) => void;
  onSelect: (fields: AddressFields) => void;
}) {
  return (
    <div>
      <label
        htmlFor="biz-address"
        className="block text-[11px] uppercase tracking-[0.18em] text-zinc-400 font-mono font-semibold mb-1.5"
      >
        Business address
        <span className="ml-1 text-zinc-600" aria-hidden="true">
          *
        </span>
      </label>
      <AddressAutocomplete
        id="biz-address"
        value={value}
        onChange={onChange}
        onSelect={onSelect}
        placeholder="Start typing your business address…"
        required
        // Match the rest of the form's input styling — same #0d0d10
        // dark background, lime focus ring, generous padding for
        // mobile tap targets. Overrides AddressAutocomplete's default
        // operator-dashboard styling. AddressAutocomplete REPLACES
        // its DEFAULT_INPUT_CLASS when inputClassName is provided, so
        // every visual property has to be present here (no merge).
        inputClassName="w-full rounded-md border bg-[#0d0d10] border-[var(--color-border)] text-zinc-100 text-base placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-lime-400/40 px-3.5 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {/* Confirmation chip — only renders once the buyer has picked
       *  from the Mapbox dropdown. Reveals the FULL canonical address
       *  (city / region / postcode) so the buyer can verify what
       *  Mapbox locked in, even though the input itself only displays
       *  the street line after Mapbox's autofill rewrite. Without
       *  this it was easy to wonder whether your suburb / city had
       *  been captured correctly. */}
      {picked ? (
        <div
          className="mt-2 flex items-start gap-2 rounded-md border px-3 py-2"
          style={{
            background: 'rgba(197, 255, 58, 0.06)',
            borderColor: 'rgba(197, 255, 58, 0.25)',
          }}
        >
          <CheckCircle2
            size={14}
            strokeWidth={2.25}
            className="mt-0.5 flex-shrink-0"
            style={{ color: 'var(--color-lime)' }}
          />
          <div className="text-xs leading-relaxed">
            <span className="text-zinc-400">Locked in: </span>
            <span className="text-zinc-100">{picked.formatted}</span>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
          Start typing, then <span className="text-zinc-300 font-semibold">pick from the dropdown</span> — required so we lock the right location (city / state / postcode) for your scan. Free-text addresses aren&apos;t accepted.
        </p>
      )}
    </div>
  );
}
