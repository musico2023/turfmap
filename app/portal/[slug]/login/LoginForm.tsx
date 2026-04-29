'use client';

import { useState } from 'react';
import { Activity, ChevronRight, Mail } from 'lucide-react';

export function LoginForm({
  clientId,
  initialError,
}: {
  clientId: string;
  initialError: string | null;
}) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, email: email.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center py-4">
        <div
          className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
          style={{ background: '#1a2010', border: '1px solid var(--color-border-bright)' }}
        >
          <Mail size={20} style={{ color: 'var(--color-lime)' }} />
        </div>
        <h3 className="font-display text-lg font-bold mb-2">Check your email</h3>
        <p className="text-xs text-zinc-400 leading-relaxed max-w-sm mx-auto">
          We sent a sign-in link to <span className="text-zinc-200 font-mono">{email}</span>.
          Open it on this device to access your portal.
        </p>
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setEmail('');
          }}
          className="mt-5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
        >
          ← use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 block">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoFocus
          className="w-full px-3 py-2.5 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </div>

      <button
        type="submit"
        disabled={submitting || !email.trim()}
        className="w-full px-5 py-2.5 rounded-md font-bold text-sm flex items-center justify-center gap-2 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 4px 16px #c5ff3a30',
        }}
      >
        {submitting ? (
          <>
            <Activity size={14} className="animate-pulse" /> Sending link…
          </>
        ) : (
          <>
            Email me a sign-in link <ChevronRight size={14} />
          </>
        )}
      </button>

      {error && (
        <div className="text-xs text-red-400 font-mono leading-relaxed">
          {error}
        </div>
      )}
    </form>
  );
}
