'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';

/**
 * 24-hour MAPCHECK50 countdown banner for /share preview-cohort
 * buyers. Sticky top bar, full-width, lime accent. Compresses the
 * urgency mechanic into the buyer's primary scroll axis — the
 * countdown is the first thing they read, and the unlock CTA
 * lives in the same horizontal band.
 *
 * Sister to /scan's ExpiryCountdown — same 24h offer window, same
 * cookie-only enforcement (Stripe-side MAPCHECK50 stays valid for
 * tampered cookies — acceptable risk per dev brief, urgency is a
 * psychological framing not a security boundary). Cookie name is
 * intentionally different (`share_unlock_arrival`) so:
 *
 *   - Time-on-share starts when the buyer LANDS on /share, not when
 *     they earlier visited /scan
 *   - A /scan visit doesn't poison the /share window for a buyer
 *     who comes through the /free-score → /share funnel
 *
 * On expiry the bar swaps the countdown for a "missed it — email
 * us" recovery message. Stripe still accepts MAPCHECK50 (no
 * server-side enforcement v1), but the bar reads as closed.
 *
 * Mounted only when:
 *   - client.is_preview === true (paying buyer doesn't see urgency)
 *   - discountedUnlock === true (Meta cohort only — /score homepage
 *     traffic stays at $99 list and shouldn't see MAPCHECK50 framing)
 *
 * Click on the bar triggers the same unlock flow as the inline
 * UnlockShareButton — POSTs to /api/score/unlock-init and
 * hard-navigates to the resulting Stripe Checkout URL. Buyer never
 * has to scroll to convert.
 */

const COOKIE_NAME = 'share_unlock_arrival';
const WINDOW_MS = 24 * 60 * 60 * 1000;
// 30-day persistence outlasts the 24h offer window so a returning
// visitor at hour 25 sees the "expired" framing instead of a fresh
// countdown. Same rationale as ExpiryCountdown on /scan.
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const c of document.cookie.split('; ')) {
    const [k, v] = c.split('=');
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSec: number): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(
    value
  )}; max-age=${maxAgeSec}; path=/; samesite=lax`;
}

function getOrStampArrival(): Date {
  const existing = readCookie(COOKIE_NAME);
  if (existing) {
    const parsed = new Date(existing);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const now = new Date();
  writeCookie(COOKIE_NAME, now.toISOString(), COOKIE_MAX_AGE_SEC);
  return now;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'EXPIRED';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

export type ShareCountdownBannerProps = {
  shareId: string;
  /** Discounted unlock cohort gate. The banner only renders when
   *  true — homepage /score traffic stays at $99 list and the
   *  MAPCHECK50 framing wouldn't apply. */
  discountedUnlock: boolean;
};

export function ShareCountdownBanner({
  shareId,
  discountedUnlock,
}: ShareCountdownBannerProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!discountedUnlock) return;
    const arrival = getOrStampArrival();
    const expiryMs = arrival.getTime() + WINDOW_MS;
    const tick = () => setRemainingMs(Math.max(0, expiryMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [discountedUnlock]);

  if (!discountedUnlock) return null;

  const onUnlockClick = async () => {
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

  const expired = remainingMs !== null && remainingMs <= 0;
  // Pre-mount placeholder reuses the same string shape as the live
  // countdown so the visual flash on first tick is barely perceptible.
  const countdownLabel =
    remainingMs === null ? '23h 59m 59s' : formatRemaining(remainingMs);

  return (
    <div
      className="sticky top-0 z-40 w-full border-b"
      style={{
        background:
          'linear-gradient(135deg, #0d130a 0%, var(--color-card-glow) 100%)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 1px 24px #c5ff3a26',
      }}
      role="region"
      aria-label="MAPCHECK50 offer countdown"
    >
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-2.5 md:py-3 flex items-center justify-between gap-3">
        {/* Left side — countdown */}
        <div className="flex items-center gap-2.5 md:gap-3 min-w-0 flex-1">
          {/* Pulsing dot */}
          <span
            className="hidden md:block w-2 h-2 rounded-full flex-shrink-0 animate-pulse"
            style={{ background: 'var(--color-lime)' }}
            aria-hidden
          />
          <div className="flex flex-col md:flex-row md:items-baseline md:gap-2 min-w-0">
            <span className="text-[10px] md:text-[11px] uppercase tracking-[0.18em] font-mono font-bold text-zinc-300">
              {expired ? 'MAPCHECK50' : 'MAPCHECK50 expires in'}
            </span>
            <span
              className="font-display text-base md:text-xl font-bold tabular-nums leading-tight"
              style={{ color: 'var(--color-lime)' }}
            >
              {expired ? 'EXPIRED' : countdownLabel}
            </span>
            <span className="hidden md:inline text-xs text-zinc-400 leading-tight">
              {expired ? (
                <>— email <span className="font-mono">hello@turfmap.ai</span> if you still want $49</>
              ) : (
                <>
                  — <span className="text-zinc-100 font-semibold">$50 off</span>{' '}
                  <span className="line-through text-zinc-500">$99</span> today only
                </>
              )}
            </span>
          </div>
        </div>

        {/* Right side — CTA */}
        <button
          type="button"
          onClick={onUnlockClick}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-2 md:px-4 md:py-2.5 rounded-md font-display font-bold text-xs md:text-sm text-black transition-all whitespace-nowrap flex-shrink-0"
          style={{
            background: 'var(--color-lime)',
            boxShadow: '0 0 20px #c5ff3a55',
            opacity: busy ? 0.7 : 1,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span className="hidden md:inline">Opening checkout…</span>
              <span className="md:hidden">Opening…</span>
            </>
          ) : (
            <>
              <Lock size={13} strokeWidth={2.5} className="hidden md:inline" />
              <span className="md:hidden">Unlock — $49</span>
              <span className="hidden md:inline">Unlock everything — $49</span>
              <ArrowRight size={13} strokeWidth={2.5} />
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="max-w-7xl mx-auto px-4 md:px-6 pb-2">
          <p
            className="text-xs leading-relaxed"
            style={{ color: '#f5b651' }}
          >
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
