'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';

/**
 * Manual on-demand poll button for the dashboard's citations panel.
 * POSTs to /api/citations/poll with the local citation_orders.id and
 * refreshes the route on success so the panel re-renders with the
 * fresh status. Operators use this when they don't want to wait for
 * the hourly cron tick (e.g. just submitted, watching a campaign
 * actively, or a status change is overdue).
 */
export function PollCitationsNowButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    setPolling(true);
    try {
      const res = await fetch('/api/citations/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolling(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={polling}
        className="text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded font-mono inline-flex items-center gap-1.5 text-zinc-400 hover:text-zinc-100 transition-colors border border-transparent hover:border-zinc-700 disabled:opacity-60 disabled:cursor-wait"
        title="Poll BL for the latest status now"
      >
        {polling ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <RefreshCw size={11} />
        )}
        {polling ? 'Polling…' : 'Poll now'}
      </button>
      {error && (
        <span className="text-[10px] text-red-400 font-mono max-w-xs text-right">
          {error}
        </span>
      )}
    </div>
  );
}
