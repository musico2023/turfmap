'use client';

import { useEffect, useState } from 'react';
import { ArrowDown } from 'lucide-react';

/**
 * Mobile-only sticky bottom bar for the free-TurfScore funnel landers
 * (/free-score, /prove-it). Drop-in alternative to StickyCheckoutBar
 * for landers whose conversion event is a scroll-to-form anchor rather
 * than a Stripe Checkout click.
 *
 * Visibility is gated by TWO IntersectionObservers, watching two DOM
 * elements rendered inline with the lander:
 *
 *   - HERO sentinel (`heroSentinelId`) — an invisible 1-px div placed
 *     immediately after the hero's primary CTA. While in view, the
 *     buyer can still see the hero CTA and doesn't need the sticky.
 *
 *   - FORM sentinel (`formAnchorId`) — the actual <section> that
 *     contains the intake form. When the buyer scrolls down far
 *     enough that the form is in view, we hide the sticky so two
 *     "Get my free TurfScore" CTAs don't compete for the same click.
 *
 * Show iff: hero CTA is OFF-screen AND form is OFF-screen
 *           (i.e. the buyer is mid-page between the two).
 *
 * Mobile-only (md:hidden). Desktop users can scroll up easily; on
 * mobile the sticky is a meaningful tap-target convenience.
 *
 * The CTA button is a plain anchor link (#formAnchorId), not a
 * button — preserves browser scroll-anchor semantics + middle-click
 * + open-in-new-tab + a11y focus order.
 */

export type StickyFreeScoreBarProps = {
  /** id of the form `<section>` the CTA scrolls to. Also Intersection-
   *  observed: while this section is in view, the sticky hides. */
  formAnchorId: string;
  /** id of an invisible sentinel placed immediately after the hero's
   *  primary CTA. When this scrolls off, the sticky slides up. */
  heroSentinelId: string;
  /** Optional override for the button label. Defaults to the
   *  free-TurfScore CTA copy. */
  buttonLabel?: string;
};

export function StickyFreeScoreBar({
  formAnchorId,
  heroSentinelId,
  buttonLabel = 'Get my free TurfScore',
}: StickyFreeScoreBarProps) {
  // Default hidden so first-paint doesn't flash. Two observers feed
  // independent visibility signals — sticky shows only when BOTH the
  // hero sentinel is off-screen AND the form section is off-screen.
  const [heroOffScreen, setHeroOffScreen] = useState(false);
  const [formOffScreen, setFormOffScreen] = useState(true);

  useEffect(() => {
    const hero = document.getElementById(heroSentinelId);
    const form = document.getElementById(formAnchorId);
    if (!hero) return;

    const heroObserver = new IntersectionObserver(
      ([entry]) => setHeroOffScreen(!entry.isIntersecting),
      { threshold: 0 }
    );
    heroObserver.observe(hero);

    // Form sentinel optional — if missing the bar still works,
    // just won't auto-hide when the form is in view.
    let formObserver: IntersectionObserver | null = null;
    if (form) {
      formObserver = new IntersectionObserver(
        ([entry]) => setFormOffScreen(!entry.isIntersecting),
        { threshold: 0 }
      );
      formObserver.observe(form);
    }

    return () => {
      heroObserver.disconnect();
      formObserver?.disconnect();
    };
  }, [heroSentinelId, formAnchorId]);

  const visible = heroOffScreen && formOffScreen;

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
      // Keep the sticky out of the a11y tab order when off-screen.
      aria-hidden={!visible}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            Free TurfScore
          </span>
          <span className="text-sm">
            <span className="font-bold text-zinc-100">60 seconds</span>{' '}
            <span className="text-xs text-zinc-400">· no card</span>
          </span>
        </div>
        <a
          href={`#${formAnchorId}`}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-md font-display font-bold text-sm transition-all whitespace-nowrap"
          style={{
            background: 'var(--color-lime)',
            color: '#000',
            boxShadow: '0 0 16px #c5ff3a40',
          }}
          // Skip the bar when the sticky is hidden — same a11y rationale
          // as the parent's aria-hidden, applied to the focusable child.
          tabIndex={visible ? 0 : -1}
        >
          {buttonLabel}
          <ArrowDown size={13} className="rotate-180" strokeWidth={2.75} />
        </a>
      </div>
    </div>
  );
}
