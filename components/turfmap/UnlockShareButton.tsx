'use client';

/**
 * UnlockShareButton — fires the /score → $99 unlock flow.
 *
 * POSTs to /api/score/unlock-init with the share_id, receives back a
 * Stripe Checkout URL, hard-navigates the browser there. On Stripe
 * success the buyer redirects to /order/success, which auto-fulfills
 * (AI Coach gens, portal access provisions) and renders the
 * audit-upgrade panel. On Stripe cancel, returns to /share/<id>?unlock_cancelled=1.
 *
 * Used by the three preview-mode lock components on /share/<id>:
 *   - PreviewHeatmapLock — prominent primary placement
 *   - PreviewAICoachLock — secondary CTA inside the panel
 *   - PreviewCompetitorLock — small inline link
 *
 * All three drive the same endpoint; multiple visible CTAs is fine
 * because they each frame the value differently (heatmap = "see the
 * map", AI Coach = "see the fixes", competitor = "see who's beating
 * you").
 *
 * variant='primary' (default) — full lime button, for the heatmap
 * lock overlay.
 * variant='ghost' — subtle text + arrow, for inline use in the
 * AI Coach / competitor locks.
 */

import { useState } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';

export type UnlockShareButtonProps = {
  shareId: string;
  variant?: 'primary' | 'ghost';
  /** Override the button copy. Defaults to "Unlock the full map — $99". */
  label?: string;
};

export function UnlockShareButton({
  shareId,
  variant = 'primary',
  label,
}: UnlockShareButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/score/unlock-init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share_id: shareId }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(
          data.error ??
            "Couldn't open Stripe Checkout. Try again, or email hello@turfmap.ai."
        );
        setBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const resolvedLabel = label ?? 'Unlock the full map — $99';

  if (variant === 'ghost') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 text-xs text-zinc-300 hover:text-white transition-colors font-semibold"
      >
        {busy && <Loader2 size={11} className="animate-spin" />}
        {resolvedLabel}
        <ArrowRight size={11} strokeWidth={2.5} />
      </button>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-lg font-display font-bold text-base text-black transition-all"
        style={{
          background: 'var(--color-lime)',
          boxShadow: '0 0 32px #c5ff3a55, 0 4px 16px rgba(0,0,0,0.4)',
          opacity: busy ? 0.7 : 1,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Opening checkout…
          </>
        ) : (
          <>
            <Lock size={16} strokeWidth={2.5} />
            {resolvedLabel}
            <ArrowRight size={16} strokeWidth={2.5} />
          </>
        )}
      </button>
      {error && (
        <p
          className="text-xs leading-relaxed text-center max-w-sm"
          style={{ color: '#f5b651' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
