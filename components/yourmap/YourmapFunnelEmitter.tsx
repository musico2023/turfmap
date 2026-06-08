'use client';

/**
 * Client-side cold-funnel event emitter for /yourmap.
 *
 * Fires 4 events per session at most:
 *   1. yourmap_view           — on mount (every page load)
 *   2. yourmap_scroll_50      — when 50% of document height has been
 *                                scrolled past the viewport top
 *   3. yourmap_scroll_form    — when the CTA section enters viewport
 *   4. coldscan_cta_click     — wired separately on the CTA button
 *                                via the exposed window dispatch
 *                                (PricePanel doesn't accept arbitrary
 *                                onClick — see "CTA click wiring"
 *                                below)
 *
 * Each event is sent ONCE per session via fetch + keepalive: true
 * (the modern sendBeacon equivalent that also works on POST and
 * lets us read the response status in dev tools). Failures are
 * swallowed — funnel events are best-effort instrumentation, never
 * critical to the page itself.
 *
 * Module-level dedup map keyed by event_type prevents double-fires
 * across React strict-mode re-mounts in dev and the rare case
 * where scroll observers fire twice on the same threshold. Stored
 * outside the component so the dedup survives effect cleanup.
 *
 * CTA click wiring:
 *   The "Run my free TurfScan" button is rendered by <PricePanel>
 *   deep in the tree and doesn't accept a custom onClick. Rather
 *   than thread props down 4 layers, this emitter attaches a
 *   delegated click listener on document.body that matches the
 *   button via a data-attribute (data-funnel-cta="coldscan").
 *   PricePanel just needs that attribute on its CTA <Link>; no
 *   imperative wiring required.
 */

import { useEffect } from 'react';

type Props = {
  prospectId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

// Module-level so it persists across React strict-mode double-mount.
// Keyed by event_type alone (we only emit each once per session,
// regardless of prospect — a session is necessarily one prospect).
const FIRED = new Set<string>();

function emit(
  eventType:
    | 'yourmap_view'
    | 'yourmap_scroll_50'
    | 'yourmap_scroll_form'
    | 'coldscan_cta_click',
  payload: Omit<Props, never>
) {
  if (FIRED.has(eventType)) return;
  FIRED.add(eventType);

  // keepalive: true lets the request survive a navigation away from
  // the page (critical for the CTA click event, where the user is
  // about to leave for the next step). Fire-and-forget; we don't
  // read the response or block navigation on it.
  try {
    void fetch('/api/funnel/track', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: eventType,
        prospect_id: payload.prospectId,
        utm_source: payload.utmSource,
        utm_medium: payload.utmMedium,
        utm_campaign: payload.utmCampaign,
      }),
    }).catch(() => {
      /* funnel events are best-effort */
    });
  } catch {
    /* funnel events are best-effort */
  }
}

export function YourmapFunnelEmitter(props: Props) {
  useEffect(() => {
    // 1. yourmap_view fires immediately on mount.
    emit('yourmap_view', props);

    // 2. scroll_50: wait until 50% of document height has scrolled
    //    past the viewport top. Uses a passive scroll listener so it
    //    doesn't block paint.
    const onScroll = () => {
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.documentElement.scrollHeight;
      if (total > 0 && scrolled / total >= 0.5) {
        emit('yourmap_scroll_50', props);
        window.removeEventListener('scroll', onScroll);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    // 3. scroll_form: IntersectionObserver on the CTA section. The
    //    section needs data-funnel-section="cta" — PricePanel's
    //    wrapper carries it (see /yourmap/page.tsx).
    let observer: IntersectionObserver | null = null;
    const ctaSection = document.querySelector<HTMLElement>(
      '[data-funnel-section="cta"]'
    );
    if (ctaSection && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              emit('yourmap_scroll_form', props);
              observer?.disconnect();
              break;
            }
          }
        },
        { threshold: 0.25 }
      );
      observer.observe(ctaSection);
    }

    // 4. cta_click: delegated click listener on document.body. Any
    //    element marked data-funnel-cta="coldscan" triggers the
    //    event before the navigation happens. The button might be a
    //    Link, button, or wrapper — closest() handles all three.
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const hit = target.closest<HTMLElement>(
        '[data-funnel-cta="coldscan"]'
      );
      if (hit) {
        emit('coldscan_cta_click', props);
      }
    };
    document.addEventListener('click', onClick, { capture: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      document.removeEventListener('click', onClick, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
