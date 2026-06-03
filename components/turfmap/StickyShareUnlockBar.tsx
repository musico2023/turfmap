'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';

/**
 * Mobile-only sticky bottom bar for /share preview cohort.
 *
 * Companion to the top countdown banner — that bar carries the
 * urgency framing (24h MAPCHECK50 expiry), this bar carries the
 * thumb-friendly always-available tap target as the buyer scrolls
 * past the inline unlock cards.
 *
 * Visibility is gated by TWO IntersectionObservers, watching two
 * sentinels rendered inline on /share:
 *
 *   - HERO sentinel (`#share-sticky-sentinel`) — placed
 *     immediately after the heatmap-lock unlock CTA. While in view,
 *     the buyer can still see that CTA and doesn't need the sticky.
 *
 *   - FINAL sentinel (`#share-final-sentinel`) — placed at the top
 *     of the AI Coach lock. While in view, hide the sticky so two
 *     "Unlock everything" CTAs don't compete for the same tap.
 *
 * Show iff: hero sentinel OFF-screen AND final sentinel OFF-screen.
 *
 * Mobile-only (md:hidden) — desktop has the top countdown banner
 * pinned with its own CTA + the inline cards stay reachable.
 *
 * Renders nothing when discountedUnlock is false (homepage /score
 * traffic stays at $99 list and doesn't get the MAPCHECK50 framing
 * a bottom-sticky $49 bar implies).
 */

const HERO_SENTINEL_ID = 'share-sticky-sentinel';
const FINAL_SENTINEL_ID = 'share-final-sentinel';

export type StickyShareUnlockBarProps = {
  shareId: string;
  discountedUnlock: boolean;
};

export function StickyShareUnlockBar({
  shareId,
  discountedUnlock,
}: StickyShareUnlockBarProps) {
  const [heroOffScreen, setHeroOffScreen] = useState(false);
  const [finalOffScreen, setFinalOffScreen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hero = document.getElementById(HERO_SENTINEL_ID);
    const final = document.getElementById(FINAL_SENTINEL_ID);
    if (!hero) return;

    const heroObserver = new IntersectionObserver(
      ([entry]) => setHeroOffScreen(!entry.isIntersecting),
      { threshold: 0 }
    );
    heroObserver.observe(hero);

    let finalObserver: IntersectionObserver | null = null;
    if (final) {
      finalObserver = new IntersectionObserver(
        ([entry]) => setFinalOffScreen(!entry.isIntersecting),
        { threshold: 0 }
      );
      finalObserver.observe(final);
    }

    return () => {
      heroObserver.disconnect();
      finalObserver?.disconnect();
    };
  }, []);

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

  const visible = heroOffScreen && finalOffScreen;

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-40 md:hidden transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
      style={{
        background: 'var(--color-card)',
        borderTop: '1px solid var(--color-border-bright)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
      }}
      aria-hidden={!visible}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            Full map · competitors · Fix List
          </span>
          <span className="text-sm leading-tight mt-0.5">
            <span className="line-through text-zinc-500">$99</span>{' '}
            <span className="font-bold text-zinc-100">$49</span>{' '}
            <span className="text-xs text-zinc-400">with MAPCHECK50</span>
          </span>
        </div>
        <button
          type="button"
          onClick={onUnlockClick}
          disabled={busy}
          tabIndex={visible ? 0 : -1}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md font-display font-bold text-sm text-black transition-all whitespace-nowrap flex-shrink-0"
          style={{
            background: 'var(--color-lime)',
            boxShadow: '0 0 20px #c5ff3a55',
            opacity: busy ? 0.7 : 1,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Opening…
            </>
          ) : (
            <>
              <Lock size={13} strokeWidth={2.5} />
              Unlock
              <ArrowRight size={14} strokeWidth={2.5} />
            </>
          )}
        </button>
      </div>
      {error && (
        <p
          className="text-[11px] leading-relaxed px-4 pb-2"
          style={{ color: '#f5b651' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** Hero sentinel id — exported so /share's JSX uses the same string
 *  as the observer. Place IMMEDIATELY after the heatmap-lock unlock
 *  CTA in the layout. */
export const SHARE_HERO_SENTINEL_ID = HERO_SENTINEL_ID;

/** Final sentinel id — exported for the AI Coach lock area, where
 *  the buyer's inline CTA takes over and the bottom sticky should
 *  hide to avoid double-CTA-in-viewport. */
export const SHARE_FINAL_SENTINEL_ID = FINAL_SENTINEL_ID;
