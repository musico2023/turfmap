'use client';

import { useEffect, useState } from 'react';

/**
 * 24-hour MAPCHECK50 expiry countdown.
 *
 * On first /scan visit (no cookie yet) we stamp `mapcheck50_arrival`
 * with the current ISO timestamp. The countdown reads from that
 * cookie and decrements live until expiry.
 *
 * Persistence: the cookie's max-age is intentionally 30 days, not 24h.
 * The OFFER window stays 24h (computed from the stamped arrival), but
 * we keep the cookie around longer so a returning visitor at hour 25
 * sees the "expired" state — not a fresh 24h window. A 24h cookie
 * max-age would auto-evict at exactly the moment the buyer most needs
 * to see "you missed it," which would let them re-trigger arrival
 * and silently reset the window.
 *
 * Buyer who clears cookies or switches devices still gets a fresh
 * window — accepted trade-off; the urgency mechanic is psychological
 * framing, not a security boundary (per dev brief).
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
// 30-day cookie persistence — see header note. Outlasts the 24h offer
// window so the "expired" state can render for returning visitors.
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
  if (ms <= 0) {
    // Brief Option A: when the offer window has closed, replace the
    // countdown with a clear post-expiry message + a recovery path.
    // Stripe-side enforcement is deferred to v2, so MAPCHECK50 is
    // technically still valid in Stripe — surface a contact channel
    // for buyers who want to redeem after the window.
    return 'Coupon expired — email hello@turfmap.ai if you need a new code';
  }
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
