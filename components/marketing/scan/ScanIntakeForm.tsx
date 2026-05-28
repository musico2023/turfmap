'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { trackMetaEvent } from '@/components/marketing/scan/MetaPixel';

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
  // Attribution params forwarded from the upstream lander via /scan/intake
  // URL → carried into the init endpoint → stamped onto Stripe metadata.
  // Each independently optional.
  coupon?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  gclid?: string | null;
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
};

export function ScanIntakeForm({
  coupon = null,
  utmSource,
  utmMedium,
  utmCampaign,
  gclid,
  prospectId = null,
  finalCents = null,
  prefillBusinessName = null,
  prefillKeyword = null,
}: ScanIntakeFormProps) {
  const [businessName, setBusinessName] = useState(prefillBusinessName ?? '');
  const [address, setAddress] = useState('');
  const [keyword, setKeyword] = useState(prefillKeyword ?? '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    // Meta InitiateCheckout — the brief's "Stripe-flow-starts" event.
    // Moved from the lander CTA click to the intake-form submit since
    // that's where the actual Stripe Checkout flow begins. Value is
    // the actual paid amount (post-coupon), so VIP $0 buyers don't
    // get counted as paid conversions in Meta.
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

    try {
      const res = await fetch('/api/scan/checkout/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          businessName: businessName.trim(),
          address: address.trim(),
          keyword: keyword.trim(),
          email: email.trim(),
          phone: phone.trim(),
          coupon: coupon ?? undefined,
          utm_source: utmSource ?? undefined,
          utm_medium: utmMedium ?? undefined,
          utm_campaign: utmCampaign ?? undefined,
          gclid: gclid ?? undefined,
          prospect_id: prospectId ?? undefined,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(
          data.error ??
            "We couldn't open Stripe Checkout. Try again, or email hello@turfmap.ai."
        );
        setLoading(false);
        return;
      }
      // Hard navigation — Stripe Checkout is a different origin so
      // router.push won't help us.
      window.location.assign(data.url);
    } catch (err) {
      setLoading(false);
      setError(
        err instanceof Error
          ? `Network error: ${err.message}`
          : "We couldn't reach Stripe. Try again, or email hello@turfmap.ai."
      );
    }
  };

  return (
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
      <Field
        label="Business address"
        id="biz-address"
        value={address}
        onChange={setAddress}
        placeholder="123 Main St, Toronto, ON"
        autoComplete="street-address"
        required
        hint="The address Google sees for your business. Used to seed the 9×9 scan grid around your service area."
      />
      <Field
        label="Keyword to scan"
        id="biz-keyword"
        value={keyword}
        onChange={setKeyword}
        placeholder='e.g. "plumber toronto" or "ac repair calgary"'
        required
        hint="The search your highest-value customers actually type. Not your business name — what someone searching for what you do would enter."
      />
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
        label="Phone"
        id="biz-phone"
        type="tel"
        value={phone}
        onChange={setPhone}
        placeholder="(416) 555-1234"
        autoComplete="tel"
        required
        hint="The Phone in NAP — used for the citation-consistency check across directories."
      />

      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={loading}
          loadingLabel={
            finalCents === 0
              ? 'Confirming your free scan…'
              : 'Opening secure checkout…'
          }
          rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
        >
          {finalCents === 0
            ? 'Continue — free with code'
            : finalCents != null
              ? `Continue to secure checkout — $${finalCents / 100}`
              : 'Continue to secure checkout'}
        </Button>
        <p className="mt-3 text-xs text-zinc-500 leading-relaxed flex items-center gap-1.5">
          <Lock size={11} className="text-zinc-600" />
          {finalCents === 0 ? (
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
