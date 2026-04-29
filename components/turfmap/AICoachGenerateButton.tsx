'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ChevronRight } from 'lucide-react';

export type AICoachGenerateButtonProps = {
  scanId: string;
};

/**
 * Triggers POST /api/ai/insights for the latest scan and refreshes the page
 * on success so the server component can render the persisted insight.
 *
 * The Anthropic call typically takes 5-15s with adaptive thinking. The button
 * shows a "Generating playbook..." state while in flight.
 */
export function AICoachGenerateButton({ scanId }: AICoachGenerateButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = isLoading || isPending;

  const onClick = async () => {
    setError(null);
    setIsLoading(true);
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
      {error && (
        <span className="text-[11px] text-red-400 font-mono max-w-xs text-right">
          {error}
        </span>
      )}
    </div>
  );
}
