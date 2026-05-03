'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ChevronRight } from 'lucide-react';

export type AICoachGenerateButtonProps = {
  scanId: string;
};

/**
 * Triggers POST /api/ai/insights for the latest scan and refreshes the page
 * on success so the server component can render the persisted insight.
 *
 * Wait time is variable:
 *   - Hot path (NAP audit already complete or none in flight): ~10-15s
 *     for the Anthropic call alone.
 *   - Cold path (a NAP audit is still running for this client): the route
 *     blocks polling BrightLocal until the audit finishes, then runs the
 *     Anthropic call. Up to ~4 minutes total.
 *
 * The button shows a "Generating playbook…" state plus an elapsed timer
 * so the operator knows it's still working through the longer wait.
 */
export function AICoachGenerateButton({ scanId }: AICoachGenerateButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const busy = isLoading || isPending;

  // Tick the elapsed counter while busy so the operator sees progress
  // through a multi-minute audit-poll wait instead of a frozen spinner.
  useEffect(() => {
    if (!busy || !startedAt) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [busy, startedAt]);

  const onClick = async () => {
    setError(null);
    setIsLoading(true);
    setStartedAt(Date.now());
    try {
      const res = await fetch('/api/ai/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        setIsLoading(false);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="px-4 py-2 rounded-md text-xs font-bold border transition-all flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          borderColor: 'var(--color-border-bright)',
          color: 'var(--color-lime)',
          background: '#0a0f04',
        }}
      >
        {busy ? (
          <>
            <Activity size={12} className="animate-pulse" />
            Generating playbook…
          </>
        ) : (
          <>
            Generate playbook <ChevronRight size={12} />
          </>
        )}
      </button>
      {busy && elapsed >= 10 && (
        <span className="text-[10px] text-zinc-500 font-mono">
          {formatElapsed(elapsed)}
          {elapsed >= 30 && ' · waiting on citation audit'}
        </span>
      )}
      {error && (
        <span className="text-[11px] text-red-400 font-mono max-w-xs text-right">
          {error}
        </span>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0
    ? `${m}:${s.toString().padStart(2, '0')} elapsed`
    : `${s}s elapsed`;
}
