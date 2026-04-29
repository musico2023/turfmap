'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, Trash2 } from 'lucide-react';

export type DeleteClientCardProps = {
  clientId: string;
  businessName: string;
};

/**
 * "Danger zone" card on the settings page. Operator must type the client's
 * business name *exactly* before the delete button activates — same pattern
 * GitHub uses for repo deletion. The DELETE endpoint also re-checks the
 * match server-side so a tampered client can't bypass it.
 */
export function DeleteClientCard({
  clientId,
  businessName,
}: DeleteClientCardProps) {
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const matches = confirm === businessName;

  const onClick = async () => {
    if (!matches) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_business_name: businessName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `delete failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      // Success — back to the agency home.
      startTransition(() => {
        router.push('/');
        router.refresh();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: '#3a1010',
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={16} className="text-red-400" />
        <h3 className="font-display text-lg font-bold text-red-400">
          Danger zone
        </h3>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed mb-4 max-w-2xl">
        Permanently deletes this client and{' '}
        <span className="text-zinc-300 font-semibold">
          everything attached to it
        </span>
        : every scan, every grid point, every AI insight, every tracked
        keyword, and every portal user. This cannot be undone — there&apos;s
        no soft-delete and no recovery from the database.
      </p>

      <div className="space-y-3 max-w-xl">
        <div>
          <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 block">
            Type the business name to confirm
          </label>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={businessName}
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-red-900 transition-colors"
            autoComplete="off"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          {error && (
            <span className="text-xs text-red-400 font-mono flex-1">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={onClick}
            disabled={!matches || submitting}
            className="ml-auto px-4 py-2 rounded-md font-bold text-xs flex items-center gap-1.5 transition-all border disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
            style={{
              background: matches ? '#3a0a0a' : '#1a0a0a',
              color: matches ? '#ff6b6b' : '#52525b',
              borderColor: matches ? '#7f1d1d' : '#3a1010',
            }}
          >
            {submitting ? (
              <>
                <Activity size={12} className="animate-pulse" /> Deleting…
              </>
            ) : (
              <>
                <Trash2 size={12} /> Delete client forever
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
