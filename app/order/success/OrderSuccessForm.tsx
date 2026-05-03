'use client';

import { useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

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
}: {
  tier: string | null;
  sessionId: string | null;
  keywordCount: number;
}) {
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [keywords, setKeywords] = useState<string[]>(
    Array(keywordCount).fill('')
  );
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        'Order session id is missing — checkout link looks malformed. Email anthony@fourdots.io and we will fire your scan manually.'
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
      // 404 here is expected during the pre-launch period before
      // /api/orders/fulfill is wired up. Surface a helpful message
      // rather than the raw status.
      if (res.status === 404) {
        setError(
          "Order intake isn't wired yet. We saw your payment — email anthony@fourdots.io with these details and we'll fire your scan within the hour."
        );
        setBusy(false);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `submit failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div
        className="border rounded-lg p-8 text-center"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <div className="font-display text-2xl font-bold mb-3">
          Scan firing now.
        </div>
        <p className="text-zinc-300 leading-relaxed max-w-xl mx-auto mb-6">
          We&rsquo;ll send your TurfMap to{' '}
          <span className="font-mono text-zinc-100">{email}</span> within 5–10
          minutes. You can close this tab.
        </p>
        {tier !== 'scan' && (
          <p className="text-sm text-zinc-500 leading-relaxed max-w-xl mx-auto">
            Your strategist will email separately within 2 business days with
            the written diagnosis
            {tier === 'strategy' && ' and a calendar link to book your call'}.
          </p>
        )}
      </div>
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
          className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </Field>

      <Field
        label="Service address"
        required
        hint="The physical location your service operates from. We'll center the 81-cell grid on this address."
      >
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="123 Main St, Toronto, ON M5V 2L7"
          required
          className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
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
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
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
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
              />
            ))}
          </div>
        </Field>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Email" required>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
        <Field label="Phone" hint="Optional — for the strategist call only.">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(416) 555-0100"
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
      </div>

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
