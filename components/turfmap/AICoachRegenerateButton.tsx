'use client';

/**
 * AICoachRegenerateButton — agency-side regenerate affordance.
 *
 * Visible when an ai_insights row already exists for the current scan.
 * Clicking POSTs to /api/ai/insights with { regenerate: true }, which:
 *   1. Deletes the cached ai_insights row(s) for this scan.
 *   2. Re-runs generateInsight() against the LATEST client / location /
 *      sibling / NAP / GBP state.
 *   3. Inserts the fresh insight + refreshes the page.
 *
 * Use case: operator edits client_locations (add a new storefront, fix a
 * stored address), or runs a fresh NAP audit, and wants the AI Coach
 * recommendation to reflect the new context. The cached insight does NOT
 * auto-refresh — it reflects the data at generation time.
 *
 * Auth: agency-staff only (same wrapper as the original Generate path).
 * Public /share/[id] does NOT get this button — cold-cohort buyers can't
 * be allowed to burn paid Claude tokens on repeat regenerations.
 *
 * UX: less prominent than the first-time Generate button (ghost variant,
 * smaller font). Confirms before firing so an accidental click doesn't
 * cost a $0.05 Claude call + a 4-minute NAP poll wait.
 */

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScanProgress } from './ScanProgress';

const REGEN_PHRASES = [
  'Re-reading your scan data…',
  'Pulling the latest location + NAP context…',
  'Cross-referencing competitor patterns…',
  'Drafting your refreshed Fix List…',
  'Finalizing your AI Coach playbook…',
];

export type AICoachRegenerateButtonProps = {
  scanId: string;
};

export function AICoachRegenerateButton({
  scanId,
}: AICoachRegenerateButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const busy = isLoading || isPending;

  // Tick the elapsed counter while busy. setState lives inside the
  // interval callback (an external-system subscription), NOT in the
  // effect body — the body only sets up + tears down the interval,
  // satisfying react-hooks/set-state-in-effect. The reset-to-zero on
  // busy=false happens at the next onClick instead of inside the effect.
  useEffect(() => {
    if (!busy || !startedAt) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [busy, startedAt]);

  const onClick = async () => {
    // Confirm before firing — regenerate costs a Claude call + can wait
    // up to ~4 minutes if a NAP audit is still in flight. Accidental
    // clicks have real cost so the confirm is worth the friction.
    const proceed = window.confirm(
      "Regenerate this AI Coach playbook?\n\nThis runs a fresh Claude call against the latest location, NAP, and sibling data. Takes ~10-30 seconds (longer if a citation audit is still running)."
    );
    if (!proceed) return;

    setError(null);
    setElapsed(0);
    setIsLoading(true);
    setStartedAt(Date.now());
    try {
      const res = await fetch('/api/ai/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, regenerate: true }),
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
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        loading={busy}
        loadingLabel="Regenerating…"
        leftIcon={!busy ? <RefreshCw size={11} /> : undefined}
      >
        Regenerate
      </Button>
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
      {busy && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{
            background: 'rgba(10, 10, 10, 0.92)',
            backdropFilter: 'blur(4px)',
          }}
          aria-modal="true"
          role="dialog"
        >
          <ScanProgress
            phrases={REGEN_PHRASES}
            rotateMs={5000}
            className="max-w-md"
          />
        </div>
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
