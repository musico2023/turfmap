'use client';

import { useEffect, useState } from 'react';

/**
 * 24-hour MAPCHECK50 expiry countdown.
 *
 * On first /scan visit (no cookie yet) we stamp `mapcheck50_arrival`
 * with the current ISO timestamp + a 24h max-age. The countdown reads
 * from that cookie and decrements live until expiry.
 *
 * Persistence across refreshes is automatic (cookie). A buyer who
 * clears cookies or switches devices gets a fresh window — accepted
 * trade-off; the urgency mechanic is psychological framing, not a
 * security boundary (per dev brief).
 *
 * Server-side enforcement of the 24h window at Stripe-checkout time
 * is intentionally deferred to v2. v1 relies on cookie-side framing
 * + an unmodified MAPCHECK50 promotion code in Stripe (anyone with
 * a tampered cookie can still get $49 today). Acceptable risk for
 * the cold-Meta launch sprint.
 *
 * SSR: returns a static placeholder string until the first
 * client-side tick so there's no hydration mismatch. The placeholder
 * is the "expires in 24 hours" form — close enough to the live
 * countdown that the flash is barely perceptible.
 */

const COOKIE_NAME = 'mapcheck50_arrival';
const WINDOW_MS = 24 * 60 * 60 * 1000;

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
  // Cookie max-age in seconds = 24 hours. Auto-evicts after the window
  // closes so a return-after-expiry visitor gets a fresh window on the
  // next visit (per brief — cookie-cleared / new-device behavior).
  writeCookie(COOKIE_NAME, now.toISOString(), 24 * 60 * 60);
  return now;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'MAPCHECK50 has expired';
  if (ms < 60_000) return 'MAPCHECK50 expires in less than a minute';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours === 0) {
    return `MAPCHECK50 expires in ${minutes}m`;
  }
  return `MAPCHECK50 expires in ${hours}h ${minutes}m`;
}

export type ExpiryCountdownProps = {
  /** Tailwind size/color overrides applied to the root span. Default
   *  matches the small mono-style trust line on /scan. */
  className?: string;
};

export function ExpiryCountdown({
  className = 'text-xs font-mono text-zinc-500',
}: ExpiryCountdownProps) {
  // null = haven't read the cookie yet (SSR / first paint).
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    const arrival = getOrStampArrival();
    const expiryMs = arrival.getTime() + WINDOW_MS;

    const tick = () => setRemainingMs(Math.max(0, expiryMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // SSR / pre-mount placeholder. Same shape as the live countdown so
  // the flash on mount isn't visually jarring.
  if (remainingMs === null) {
    return <span className={className}>MAPCHECK50 expires in 24h</span>;
  }

  return <span className={className}>{formatRemaining(remainingMs)}</span>;
}
