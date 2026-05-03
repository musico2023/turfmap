'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Radio, Search } from 'lucide-react';

export type ScanButtonProps = {
  clientId: string;
  /** Optional — which physical location to scan. Defaults to the client's
   *  primary location server-side when not supplied. Multi-location clients
   *  pass the active location's id from the dashboard. */
  locationId?: string | null;
  /** Only the primary keyword is scanned in v1 — passed for the optimistic UI label. */
  keywordLabel?: string;
};

/**
 * Triggers POST /api/scans/trigger and refreshes the page on success so the
 * server component re-fetches the latest scan. The whole flow takes ~15-30s
 * because we're synchronous all the way through DFS — the button blocks
 * during that window.
 */
export function ScanButton({ clientId, locationId, keywordLabel }: ScanButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = isScanning || isPending;

  const onClick = async () => {
    setError(null);
    setIsScanning(true);
    try {
      const res = await fetch('/api/scans/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, locationId: locationId ?? undefined }),
      });
      // Read as text first so we can produce a useful error if Vercel
      // returns an HTML error page (function timeout, OOM, build error)
      // instead of our JSON envelope.
      const text = await res.text();
      let data: { error?: string } | null = null;
      try {
        data = JSON.parse(text) as { error?: string };
      } catch {
        // Non-JSON response — most likely a Vercel infra error page.
        const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim();
        setError(
          `scan failed (HTTP ${res.status}). Response wasn't JSON — likely a function timeout or crash. Check Vercel logs. Body: "${snippet}…"`
        );
        setIsScanning(false);
        return;
      }
      if (!res.ok) {
        setError(data?.error ?? `scan failed (HTTP ${res.status})`);
        setIsScanning(false);
        return;
      }
      // refresh the server component so the new scan shows up
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 4px 16px #c5ff3a30',
        }}
      >
        {busy ? (
          <>
            <Activity size={15} strokeWidth={2.75} className="animate-pulse" />
            Scanning territory…
          </>
        ) : keywordLabel ? (
          <>
            <Radio size={15} strokeWidth={2.75} /> Re-scan turf
          </>
        ) : (
          <>
            <Search size={15} strokeWidth={2.75} /> Run TurfScan
          </>
        )}
      </button>
      {error && (
        <span className="text-[11px] text-red-400 font-mono max-w-xs text-right">
          {error}
        </span>
      )}
    </div>
  );
}
