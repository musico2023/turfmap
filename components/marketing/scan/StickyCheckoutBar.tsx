'use client';

import { useEffect, useState } from 'react';
import { ScanCheckoutButton } from '@/components/marketing/ScanCheckoutButton';

/**
 * Mobile-only sticky bottom checkout bar for /scan.
 *
 * Appears after the buyer scrolls past the hero CTA (tracked via an
 * IntersectionObserver on a sentinel element rendered inline with the
 * hero). When the sentinel leaves the viewport — i.e. the hero CTA is
 * scrolled off — the bar slides up. When the buyer scrolls back to
 * the hero, the bar slides down out of the way.
 *
 * Desktop users have the hero CTA reachable via scroll-up; the sticky
 * is intentionally mobile-only (md:hidden). 60px tall meets the brief's
 * tap-target spec.
 *
 * The sentinel id is fixed at "scan-sticky-sentinel" — the lander
 * places `<div id="scan-sticky-sentinel" />` immediately after the
 * hero's primary CTA so "hero CTA off-screen" maps cleanly to "show
 * sticky".
 */

const SENTINEL_ID = 'scan-sticky-sentinel';

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
  // Default hidden so first paint doesn't flash. IntersectionObserver
  // toggles to visible when the hero CTA leaves the viewport.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sentinel = document.getElementById(SENTINEL_ID);
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show the sticky when the sentinel is NOT in view (buyer has
        // scrolled past the hero).
        setVisible(!entry.isIntersecting);
      },
      // 0% threshold — flip the moment any part of the sentinel
      // leaves / re-enters the viewport.
      { threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

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
        <ScanCheckoutButton
          coupon={coupon}
          utmSource={utmSource}
          utmMedium={utmMedium}
          utmCampaign={utmCampaign}
          label="Run my scan →"
        />
      </div>
    </div>
  );
}
