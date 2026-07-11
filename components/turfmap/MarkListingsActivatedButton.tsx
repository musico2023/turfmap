'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';

/**
 * Operator button on the citations panel for GHL Listings orders in
 * 'awaiting_activation'. GHL has no public API for the "enable Listings"
 * toggle, so the operator flips it in the GHL agency dashboard and then
 * clicks this to tell TurfMap the sync is live (order → 'active').
 * Agency-gated server-side (/api/citations/activate) — buyers never see
 * this button (the panel only renders it on the agency dashboard).
 */
export function MarkListingsActivatedButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/citations/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded font-mono inline-flex items-center gap-1.5 transition-colors border disabled:opacity-60 disabled:cursor-wait hover:brightness-110"
        style={{
          color: 'var(--color-lime)',
          borderColor: '#c5ff3a44',
          background: '#c5ff3a10',
        }}
        title="Confirm Listings was toggled ON for this sub-account in GHL"
      >
        {busy ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Check size={11} />
        )}
        Mark activated
      </button>
      {error && (
        <span className="text-[10px] text-red-400 max-w-[220px] text-right">
          {error}
        </span>
      )}
    </div>
  );
}
