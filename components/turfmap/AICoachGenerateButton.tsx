'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScanProgress } from './ScanProgress';

/** Phrase list calibrated to the AI Coach generation flow (vs the
 *  longer geo-grid scan flow that ScanButton owns). The hot path is
 *  ~10-15s; the cold path (NAP audit still running) can extend to
 *  ~4 minutes. Phrases hold on the last entry rather than looping so
 *  the operator never sees "Reading your scan data…" twice. */
const AI_COACH_PHRASES = [
  'Reading your scan data…',
  'Cross-referencing competitor patterns…',
  'Checking citation findings against the directory roster…',
  'Drafting your prioritized Fix List…',
  'Computing per-action TurfScore impact…',
  'Finalizing your AI Coach playbook…',
];

export type AICoachGenerateButtonProps = {
  scanId: string;
  /** When set, the button POSTs to the share-id-gated public
   *  endpoint (/api/share/<shareId>/generate-insight) instead of the
   *  agency-only /api/ai/insights. Cold-outreach buyers on
   *  /share/<id> have no Supabase auth, so this is how they
   *  generate their own Fix List. */
  shareId?: string;
};

/**
 * Triggers AI Coach generation and refreshes the page on success so
 * the server component can render the persisted insight.
 *
 * Two endpoints, picked by `shareId`:
 *   - shareId set → POST /api/share/<shareId>/generate-insight
 *     (public, share-id-gated). Used on /share/<id> for cold and
 *     coldscan buyers.
 *   - shareId unset → POST /api/ai/insights (agency-staff auth).
 *     Used on the agency console + /portal/<slug> for paying
 *     buyers with a magic-link session.
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
export function AICoachGenerateButton({
  scanId,
  shareId,
}: AICoachGenerateButtonProps) {
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
      const res = shareId
        ? await fetch(`/api/share/${shareId}/generate-insight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
        : await fetch('/api/ai/insights', {
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
      <Button
        variant="ai"
        size="md"
        onClick={onClick}
        loading={busy}
        loadingLabel="Generating playbook…"
        rightIcon={!busy ? <ChevronRight size={12} /> : undefined}
      >
        Generate playbook
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
      {/* Full-screen progress overlay during the AI Coach generation
       *  wait. Hot path ~10-15s; cold path (NAP audit still running)
       *  up to ~4 minutes. Without this overlay, the operator sees
       *  only the button's loading spinner — easy to assume the page
       *  is frozen, especially on the cold path. The button-local
       *  elapsed/timer chip is preserved underneath as a fallback
       *  for screen readers + when the operator dismisses the
       *  overlay (future). */}
      {busy && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(10, 10, 10, 0.92)', backdropFilter: 'blur(4px)' }}
          aria-modal="true"
          role="dialog"
        >
          <ScanProgress
            phrases={AI_COACH_PHRASES}
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
