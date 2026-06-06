'use client';

import Script from 'next/script';
import { useEffect } from 'react';

/**
 * Meta (Facebook) Pixel base install + page-specific event firing.
 *
 * Two components:
 *   - <MetaPixelBase /> mounts the fbq loader site-wide via app/layout.
 *     Fires PageView automatically on every page (Meta's default). If
 *     NEXT_PUBLIC_META_PIXEL_ID is unset, the component renders nothing
 *     — graceful no-op for local dev / before the pixel is provisioned.
 *
 *   - <MetaPixelTrack event="..." /> fires a single named event on mount
 *     (idempotent within the page lifecycle). Use for one-shot events
 *     like Purchase or ViewContent on a specific lander.
 *
 *   - <MetaPixelScrollDepth percent={50} event="ViewContent" /> fires a
 *     scroll-threshold event when the user has scrolled past the given
 *     viewport-height multiple (e.g. percent=50 → fires when scroll +
 *     viewport reaches 50% of document height).
 *
 *   - trackMetaEvent(name, params) — imperative helper for fbq calls
 *     from button handlers (e.g. InitiateCheckout inside
 *     ScanCheckoutButton's onClick). Safe to call before the pixel
 *     loads — fbq queues events and drains them when the loader is
 *     ready.
 *
 * Server-side Conversions API is intentionally deferred. v1 ships
 * browser-pixel only.
 */

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fbq?: (...args: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _fbq?: any;
  }
}

/** Default pixel id — Anthony's production Meta pixel for TurfMap.
 *  Hardcoded fallback (NEXT_PUBLIC_ values ship in the client bundle
 *  anyway, no secret exposure) mirrors the GA / Clarity convention in
 *  app/layout.tsx. Override via NEXT_PUBLIC_META_PIXEL_ID env var
 *  for staging / per-env pixels (set to empty string to disable). */
const DEFAULT_PIXEL_ID = '1634879350063388';

function pixelId(): string | null {
  const v = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  // Empty-string override explicitly disables the pixel (e.g. local
  // dev with `NEXT_PUBLIC_META_PIXEL_ID=""` in .env.local).
  if (v !== undefined) return v.trim() ? v.trim() : null;
  return DEFAULT_PIXEL_ID;
}

/**
 * Imperative fbq call. Safe to invoke from anywhere (server or
 * client). If the loader hasn't initialized yet, fbq queues the call
 * for replay on initialization. If NEXT_PUBLIC_META_PIXEL_ID is
 * unset, this is a no-op.
 *
 * Pass `eventID` when you ALSO send the same logical event through
 * the server-side Conversions API (lib/marketing/metaCapi) — Facebook
 * dedupes the pixel + CAPI pair via event_name + event_id within a
 * ~48-hour window. Generate the id ONCE (crypto.randomUUID()) and
 * pass it to both surfaces.
 */
export function trackMetaEvent(
  event: string,
  params?: Record<string, unknown>,
  options?: { eventID?: string }
): void {
  if (typeof window === 'undefined') return;
  if (!pixelId()) return;
  if (typeof window.fbq !== 'function') return;
  if (params && options?.eventID) {
    window.fbq('track', event, params, { eventID: options.eventID });
  } else if (params) {
    window.fbq('track', event, params);
  } else if (options?.eventID) {
    window.fbq('track', event, {}, { eventID: options.eventID });
  } else {
    window.fbq('track', event);
  }
}

/**
 * Imperative fbq('trackCustom', ...) call for CUSTOM (non-standard)
 * events. Same guards + dedup semantics as trackMetaEvent: pass
 * `eventID` when the same logical event is ALSO sent server-side via
 * sendMetaCapiEvent so Facebook dedupes the pixel + CAPI pair on
 * event_name + event_id.
 *
 * Use for purpose-built conversions we want to define a Custom
 * Conversion on and optimize a campaign toward — e.g.
 * 'FreeScoreSubmit', kept SEPARATE from the generic standard 'Lead'
 * event so Ads Manager reports + optimization key off the real
 * free-score submission and nothing else.
 */
export function trackMetaCustomEvent(
  event: string,
  params?: Record<string, unknown>,
  options?: { eventID?: string }
): void {
  if (typeof window === 'undefined') return;
  if (!pixelId()) return;
  if (typeof window.fbq !== 'function') return;
  if (params && options?.eventID) {
    window.fbq('trackCustom', event, params, { eventID: options.eventID });
  } else if (params) {
    window.fbq('trackCustom', event, params);
  } else if (options?.eventID) {
    window.fbq('trackCustom', event, {}, { eventID: options.eventID });
  } else {
    window.fbq('trackCustom', event);
  }
}

/** Read a cookie value by name. Returns null if the cookie doesn't
 *  exist or if running on the server. Used to forward _fbp/_fbc to
 *  the server for CAPI matching. */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Mounted once in app/layout.tsx. Loads the Meta pixel and fires the
 * automatic PageView. Returns null when no pixel id is configured.
 */
export function MetaPixelBase() {
  const id = pixelId();
  if (!id) return null;
  // Pixel loader — adapted from Meta's official snippet. Inlined as a
  // beforeInteractive Script so fbq is available before any page-level
  // event tries to track. The trailing fbq('init', ID) + fbq('track',
  // 'PageView') wire the SDK + fire the first event.
  return (
    <>
      <Script id="meta-pixel-loader" strategy="afterInteractive">
        {`
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
        `}
      </Script>
      {/* noscript fallback — Meta requires this for buyers with JS off
       *  + as a verification surface for pixel debugger tools. */}
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: 'none' }}
          alt=""
          src={`https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1`}
        />
      </noscript>
    </>
  );
}

/**
 * Fire a named event on mount. Use for single-shot page-level events
 * (e.g. Purchase on /order/success when amount_total > 0).
 */
export function MetaPixelTrack({
  event,
  params,
  /** When false, the event won't fire. Use to gate Purchase on the
   *  Stripe session being valid + amount > 0. */
  enabled = true,
  /** When set, fires fbq with this event_id so Meta can dedup
   *  against a server-side CAPI event carrying the same id. Critical
   *  for events where we ALSO fire CAPI (Purchase, Lead) — without
   *  it, Meta counts each event twice and inflates conversion volume.
   *  See lib/marketing/metaCapi.ts for the CAPI-side. */
  eventID,
}: {
  event: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
  eventID?: string | null;
}) {
  useEffect(() => {
    if (!enabled) return;
    trackMetaEvent(event, params, eventID ? { eventID } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, event, JSON.stringify(params), eventID]);
  return null;
}

/**
 * Fires a named event once the user has scrolled past `percent`% of
 * the document. Used for the brief's "ViewContent on 50% scroll"
 * signal — a real engagement marker, not just a page open.
 */
export function MetaPixelScrollDepth({
  percent,
  event,
}: {
  percent: number;
  event: string;
}) {
  useEffect(() => {
    let fired = false;
    const onScroll = () => {
      if (fired) return;
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.documentElement.scrollHeight;
      if (total > 0 && scrolled / total >= percent / 100) {
        fired = true;
        trackMetaEvent(event);
        window.removeEventListener('scroll', onScroll);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Fire immediately if the page is already past the threshold on mount.
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [percent, event]);
  return null;
}
