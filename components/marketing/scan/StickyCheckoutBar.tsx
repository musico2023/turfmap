'use client';

import { useEffect, useState } from 'react';
import { ScanIntakeLinkButton } from '@/components/marketing/scan/ScanIntakeLinkButton';

/**
 * Mobile-only sticky bottom checkout bar for /scan.
 *
 * Visibility is gated by TWO IntersectionObservers, watching two
 * sentinels rendered inline with the lander:
 *
 *   - HERO_SENTINEL_ID — placed immediately after the hero's primary
 *     CTA. While this sentinel is in view, the buyer can still see
 *     the hero CTA and doesn't need the sticky redundancy.
 *
 *   - FINAL_SENTINEL_ID — placed at the top of the final-CTA section.
 *     While this sentinel is in view, the buyer is looking at the
 *     large bottom CTA and we hide the sticky to avoid two competing
 *     "Run my scan" buttons in the viewport at once.
 *
 * Show iff: hero CTA is OFF-screen AND final CTA is OFF-screen
 *           (i.e. the buyer is mid-page).
 *
 * Desktop users have the hero CTA reachable via scroll-up; the sticky
 * is intentionally mobile-only (md:hidden). 60px tall meets the brief's
 * tap-target spec.
 *
 * The helper text on the sticky's checkout button is suppressed
 * (helperText={null}) — the sticky is a compact reassurance surface;
 * the click-flow line would crowd the bar visually.
 */

const HERO_SENTINEL_ID = 'scan-sticky-sentinel';
const FINAL_SENTINEL_ID = 'scan-final-cta-sentinel';

export type StickyCheckoutBarProps = {
  /** Forwarded to ScanCheckoutButton — typically 'MAPCHECK50' on
   *  /scan. Hardcoded by the parent. */
  coupon: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
};

export function StickyCheckoutBar({
  coupon,
  utmSource,
  utmMedium,
  utmCampaign,
}: StickyCheckoutBarProps) {
  // Default hidden so first paint doesn't flash. Two observers feed
  // independent visibility signals — sticky shows only when BOTH the
  // hero sentinel is off-screen AND the final-CTA sentinel is off-screen.
  const [heroOffScreen, setHeroOffScreen] = useState(false);
  const [finalOffScreen, setFinalOffScreen] = useState(true);

  useEffect(() => {
    const hero = document.getElementById(HERO_SENTINEL_ID);
    const final = document.getElementById(FINAL_SENTINEL_ID);
    if (!hero) return;

    const heroObserver = new IntersectionObserver(
      ([entry]) => setHeroOffScreen(!entry.isIntersecting),
      { threshold: 0 }
    );
    heroObserver.observe(hero);

    // The final-CTA sentinel is optional — landers without it just
    // get hero-only behavior, which matches the pre-Edit-2 default.
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

  const visible = heroOffScreen && finalOffScreen;

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-40 md:hidden transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
      style={{
        background: 'var(--color-card)',
        borderTop: '1px solid var(--color-border-bright)',
        // Honor iOS safe-area inset so the bar sits above the home indicator.
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      // Keep the sticky out of the a11y tab order when it's translated off-screen.
      aria-hidden={!visible}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            TurfScan
          </span>
          <span className="text-sm">
            <span className="line-through text-zinc-500">$99</span>{' '}
            <span className="font-bold text-zinc-100">$49</span>{' '}
            <span className="text-xs text-zinc-400">with MAPCHECK50</span>
          </span>
        </div>
        <ScanIntakeLinkButton
          coupon={coupon}
          utmSource={utmSource}
          utmMedium={utmMedium}
          utmCampaign={utmCampaign}
          label="Run my scan"
          helperText={null}
        />
      </div>
    </div>
  );
}
