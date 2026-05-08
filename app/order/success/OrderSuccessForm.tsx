'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Check, Loader2, Sparkles } from 'lucide-react';
import {
  AddressAutocomplete,
  type AddressFields,
} from '@/components/turfmap/AddressAutocomplete';
import { CalEmbed } from '@/components/turfmap/CalEmbed';
import { OnboardingWizard } from '@/components/turfmap/OnboardingWizard';
import { PulseAttachPanel } from '@/components/turfmap/PulseAttachPanel';
import type { OnboardingStep } from '@/lib/supabase/types';

/**
 * Post-checkout business-details form.
 *
 * Stripe paid → land here → fill business name / address / keyword(s) /
 * email / phone → submit → server creates a `lead_orders` row, kicks
 * the existing scan-trigger pipeline, sends a Resend confirmation,
 * and shows a "we're scanning" success state.
 *
 * For now this is a stub:
 *   - the form layout, validation, and busy-state UX is real
 *   - submission posts to /api/orders/fulfill (route TBD in next PR)
 *   - if that route doesn't exist yet we surface a clear inline error
 *
 * Trade-off accepted on purpose: we ship the form first so the
 * payment-to-scan flow has a believable handoff *now*, and wire the
 * server-side fulfillment in a follow-up commit when we have the
 * Stripe webhook + lead_orders table designed.
 */
export function OrderSuccessForm({
  tier,
  sessionId,
  keywordCount,
  prefillEmail,
  stripeCustomerId,
  attachState,
  attachPublicId,
}: {
  tier: string | null;
  sessionId: string | null;
  keywordCount: number;
  /** Buyer email captured server-side from the Stripe Checkout session.
   *  When non-null, used to pre-fill the email field — saves the
   *  buyer typing it again. They can still edit if they want a
   *  different delivery address. */
  prefillEmail: string | null;
  /** Stripe customer id from the original one-time purchase. Forwarded
   *  to the Pulse-attach panel so the trial subscription pre-binds to
   *  the same customer (no email re-entry on Stripe). Null when the
   *  session lookup couldn't recover it (e.g. Stripe not configured). */
  stripeCustomerId: string | null;
  /** Round-trip flag from the Pulse-attach Stripe redirect. When
   *  'success', the success card surfaces a confirmation banner +
   *  hides the attach panel. When 'cancelled', the attach panel
   *  remains visible so the buyer can retry. Null when the buyer
   *  hasn't engaged with the attach flow. */
  attachState: 'success' | 'cancelled' | null;
  /** Server-resolved client public_id for the attach return path.
   *  Set when attachState is non-null (the buyer is returning from
   *  Stripe Pulse-attach and shouldn't re-fill the form). Null on
   *  the initial purchase flow. */
  attachPublicId: string | null;
}) {
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [keywords, setKeywords] = useState<string[]>(
    Array(keywordCount).fill('')
  );
  const [email, setEmail] = useState(prefillEmail ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set on successful fulfillment — used to link the buyer straight
   *  to their dashboard. Null on partial-failure or pre-Stripe-wired
   *  scenarios where the email path is still our best fallback. */
  const [publicId, setPublicId] = useState<string | null>(null);
  /** Optional human-readable note from the fulfill API (used for the
   *  "partial scan failure" / "already fulfilled" cases). */
  const [partialMessage, setPartialMessage] = useState<string | null>(null);
  /** Cal.com booking URL — set on Audit + Strategy fulfillments
   *  when CAL_COM_*_URL env is configured. NULL otherwise → success
   *  state falls back to "your strategist will email" copy. */
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  /** Onboarding wizard step — set on Pulse / Pulse+ fulfillments.
   *  Null for one-time tiers + agency-managed clients. The wizard
   *  takes over the success state when present. */
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null
  );

  // Pulse-attach return path: when the buyer comes back from Stripe
  // with ?attach=success or ?attach=cancelled, server resolves the
  // existing client public_id and hands it down. We hydrate `done`
  // and `publicId` from that so the success card renders directly —
  // the buyer already filled the form on the original purchase, no
  // need to make them do it again. Runs once on mount.
  useEffect(() => {
    if (attachState && attachPublicId) {
      setPublicId(attachPublicId);
      setDone(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setKeywordAt = (idx: number, value: string) => {
    setKeywords((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Cheap client-side sanity checks. Server will re-validate.
    if (!businessName.trim()) return setError('Business name is required.');
    if (!address.trim()) return setError('Service address is required.');
    if (!email.trim()) return setError('Email is required.');
    if (keywords.some((k) => !k.trim())) {
      return setError(
        keywordCount === 1
          ? 'Keyword is required.'
          : `All ${keywordCount} keywords are required.`
      );
    }
    if (!sessionId) {
      return setError(
        'Order session id is missing — checkout link looks malformed. Email support@turfmap.ai and we will fire your scan manually.'
      );
    }

    setBusy(true);
    try {
      const res = await fetch('/api/orders/fulfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier,
          sessionId,
          businessName: businessName.trim(),
          address: address.trim(),
          keywords: keywords.map((k) => k.trim()),
          email: email.trim(),
          phone: phone.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        public_id?: string;
        primary_scan_id?: string | null;
        already_fulfilled?: boolean;
        partial?: boolean;
        message?: string;
        booking_url?: string | null;
        onboarding_step?: OnboardingStep | null;
      };

      // 409 = already fulfilled. Treat as success — show the
      // fulfilled state with whatever client_id we got back.
      // Resume the wizard if onboarding_step was returned (Pulse / Pulse+
      // who closed the tab and came back, or a refresh mid-flow).
      if (res.status === 409 && data.already_fulfilled) {
        setPublicId(typeof data.public_id === 'string' ? data.public_id : null);
        setBookingUrl(
          typeof data.booking_url === 'string' ? data.booking_url : null
        );
        setOnboardingStep(
          (data.onboarding_step as OnboardingStep | null) ?? null
        );
        setDone(true);
        setBusy(false);
        return;
      }

      // 404 still possible in the unlikely case the migration hasn't
      // landed yet (e.g. local dev pre-0008-apply). Helpful fallback
      // copy that points the buyer at email-based recovery.
      if (res.status === 404) {
        setError(
          "Order intake isn't fully wired yet. We saw your payment — email support@turfmap.ai with these details and we'll fire your scan manually."
        );
        setBusy(false);
        return;
      }

      if (!res.ok) {
        setError(data.error ?? `submit failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }

      // Capture public_id so the success state can link the buyer
      // straight to their scan dashboard. Falls back to the email-
      // delivery message when not present.
      setPublicId(typeof data.public_id === 'string' ? data.public_id : null);
      setPartialMessage(typeof data.message === 'string' ? data.message : null);
      setBookingUrl(
        typeof data.booking_url === 'string' ? data.booking_url : null
      );
      setOnboardingStep(
        (data.onboarding_step as OnboardingStep | null) ?? null
      );
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (done) {
    // Self-serve subscription buyers (Pulse / Pulse+) hand off to the
    // multi-step wizard, which manages its own UX (GBP confirmation,
    // team invites, competitors, then the "TurfMap is ready" CTA).
    // Pulse+ + Pulse only — one-time tiers fall through to the
    // existing simple success card below.
    if (onboardingStep && publicId && sessionId) {
      return (
        <OnboardingWizard
          publicId={publicId}
          sessionId={sessionId}
          initialStep={onboardingStep}
        />
      );
    }
    // Pulse-attach panel surfaces only on one-time tiers, only when
    // the buyer hasn't already opted in or cancelled mid-flow, and
    // only when we have the data needed to bind the trial to the
    // existing Stripe customer + client row.
    const isOneTimeTier =
      tier === 'scan' || tier === 'audit' || tier === 'strategy';
    const showAttachPanel =
      isOneTimeTier &&
      attachState !== 'success' &&
      publicId &&
      sessionId &&
      stripeCustomerId;

    return (
      <>
        {/* Attach success banner — shown when the buyer just came back
         *  from a successful Pulse-attach Stripe flow. Inline above
         *  the original success card so the celebratory beat compounds
         *  ("scan ready + Pulse on its way"). */}
        {attachState === 'success' && (
          <div
            className="border rounded-lg p-5 mb-5 flex items-start gap-3"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
              boxShadow: '0 0 24px #c5ff3a14',
            }}
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 18px #c5ff3a40',
              }}
            >
              <Sparkles size={16} className="text-black" strokeWidth={2.75} />
            </div>
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
                Pulse trial active
              </div>
              <div className="font-display text-lg font-bold leading-tight mb-1">
                Free for 30 days. Cancel anytime before then.
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Your map will auto-rescan weekly. We&rsquo;ll email when
                your TurfScore moves more than ±5. First charge:{' '}
                <span className="font-mono text-zinc-200">$39</span> on
                day 31 — manage the subscription anytime from your
                portal&rsquo;s billing page.
              </p>
            </div>
          </div>
        )}

        {/* Attach cancelled banner — shown when the buyer hit Cancel
         *  on Stripe's hosted page. Light reassurance + no nag, plus
         *  the original attach panel still mounts below so they can
         *  retry if they changed their mind. */}
        {attachState === 'cancelled' && (
          <div
            className="border rounded-md px-4 py-3 mb-5 flex items-start gap-2.5 text-xs"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
              color: '#a1a1aa',
            }}
          >
            <Check size={14} className="flex-shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              No problem — your TurfScan is still on its way. The Pulse
              trial offer is below if you change your mind.
            </span>
          </div>
        )}

        <div
          className="border rounded-lg p-8 text-center"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border-bright)',
          }}
        >
          <div className="font-display text-2xl font-bold mb-3">
            {publicId ? 'Your TurfMap is ready.' : 'Scan firing now.'}
          </div>
          <p className="text-zinc-300 leading-relaxed max-w-xl mx-auto mb-6">
            {partialMessage ?? (
              <>
                We&rsquo;ve sent the link to{' '}
                <span className="font-mono text-zinc-100">{email}</span>. You
                can also bookmark this page or click below to open your
                dashboard now.
              </>
            )}
          </p>
          {publicId && (
            <a
              href={`/portal/${publicId}`}
              className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-3 px-5 transition-all whitespace-nowrap hover:brightness-110"
              style={{
                background: 'var(--color-lime)',
                color: 'black',
                boxShadow: '0 6px 20px #c5ff3a40',
              }}
            >
              Open my TurfMap →
            </a>
          )}
          {(tier === 'audit' || tier === 'strategy') && bookingUrl && (
            <CalEmbed
              bookingUrl={bookingUrl}
              email={email}
              businessName={businessName}
              notes={`Booking from TurfMap ${tier === 'strategy' ? 'Strategy Session' : 'Visibility Audit'} order for ${businessName}.`}
              tierLabel={
                tier === 'strategy'
                  ? '90-min Strategy Session'
                  : '30-min Audit walkthrough'
              }
            />
          )}
          {(tier === 'audit' || tier === 'strategy') && !bookingUrl && (
            <p className="text-sm text-zinc-500 leading-relaxed max-w-xl mx-auto mt-6">
              Your strategist will email separately within 2 business days with
              the diagnosis
              {tier === 'strategy' && ' and a calendar link to book your call'}.
            </p>
          )}
        </div>

        {/* Pulse attach offer. Renders *below* the success card so the
         *  primary "you got what you paid for" beat lands first; the
         *  add-on offer is secondary, never required. */}
        {showAttachPanel && (
          <PulseAttachPanel
            publicId={publicId}
            stripeCustomerId={stripeCustomerId}
            originalSessionId={sessionId}
          />
        )}
      </>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border rounded-lg p-6 md:p-8 space-y-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <Field label="Business name" required>
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="e.g. Smith & Sons Plumbing"
          required
          className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </Field>

      <Field
        label="Service address"
        required
        hint="Start typing your address — pick from the dropdown so we can center the 81-cell grid precisely on your storefront."
      >
        <AddressAutocomplete
          value={address}
          onChange={setAddress}
          onSelect={(fields: AddressFields) => {
            // Buyer picked a Mapbox suggestion — the input now holds
            // the canonical full_address. The server-side fulfill
            // still re-geocodes via Nominatim for cross-validation,
            // but a Mapbox-resolved address effectively guarantees a
            // clean Nominatim hit.
            setAddress(fields.formatted);
          }}
          placeholder="123 Main St, Toronto"
          required
        />
      </Field>

      {keywordCount === 1 ? (
        <Field
          label="Keyword to scan"
          required
          hint='Pick the most-searched term someone would type to find a business like yours, e.g. "plumber toronto".'
        >
          <input
            type="text"
            value={keywords[0]}
            onChange={(e) => setKeywordAt(0, e.target.value)}
            placeholder="plumber toronto"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
      ) : (
        <Field
          label="Three keywords to scan"
          required
          hint="Strategy Session scans three keywords across the same grid so you can compare. Pick the strongest variant first."
        >
          <div className="space-y-2">
            {keywords.map((k, i) => (
              <input
                key={i}
                type="text"
                value={k}
                onChange={(e) => setKeywordAt(i, e.target.value)}
                placeholder={
                  i === 0
                    ? 'plumber toronto'
                    : i === 1
                      ? 'emergency plumber toronto'
                      : 'plumbing services toronto'
                }
                required
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
              />
            ))}
          </div>
        </Field>
      )}

      {/* Phone field is only relevant for strategist-call tiers
          (Audit + Strategy). Pulse / Pulse+ / Scan don't include a
          call so we hide it entirely — collecting an unused phone
          field is friction, not value. */}
      {tier === 'audit' || tier === 'strategy' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Email" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
              required
              className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
            />
          </Field>
          <Field label="Phone" hint="Optional — for the strategist call only.">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(416) 555-0100"
              className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
            />
          </Field>
        </div>
      ) : (
        <Field label="Email" required>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md font-bold text-sm py-3 px-4 flex items-center justify-center gap-2 transition-all whitespace-nowrap hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 6px 20px #c5ff3a40',
        }}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Firing your scan…
          </>
        ) : (
          <>
            Fire my TurfMap scan
            <ArrowRight size={14} strokeWidth={2.5} />
          </>
        )}
      </button>

      {error && (
        <div
          className="text-sm rounded-md p-3 leading-relaxed"
          style={{
            background: '#1a0606',
            border: '1px solid #3f0a0a',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
          {required && (
            <span className="ml-1" style={{ color: 'var(--color-lime)' }}>
              *
            </span>
          )}
        </span>
      </div>
      {children}
      {hint && (
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-snug">{hint}</p>
      )}
    </label>
  );
}
