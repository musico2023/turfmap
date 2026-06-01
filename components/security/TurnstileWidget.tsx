'use client';

/**
 * TurnstileWidget — Cloudflare Turnstile renderer (vanilla, no
 * npm dependency).
 *
 * Loads Cloudflare's challenges.cloudflare.com/turnstile/v0/api.js
 * once per page via a side-effect-managed <script> tag, then
 * imperatively renders a widget into a container ref using
 * window.turnstile.render(). The widget produces a token on
 * successful challenge; we surface it to the parent via onToken.
 *
 * Fail-soft behavior:
 *   - When NEXT_PUBLIC_TURNSTILE_SITEKEY is unset → renders nothing
 *     and emits a stable empty-string token so the form treats
 *     verification as "not required." This lets local dev + pre-
 *     setup deploys work without Turnstile.
 *   - When the script fails to load → same fallback (empty token).
 *     Backend's verifier will then reject if TURNSTILE_SECRET_KEY
 *     IS set on the server (mismatch = misconfig, fail loudly).
 *
 * Theme: explicit dark to match TurfMap's UI. Cloudflare's auto
 * theme reads prefers-color-scheme which is unreliable across
 * iframes.
 *
 * Token lifetime: ~300s per Cloudflare. The parent form submit must
 * fire within that window or the backend verifier returns
 * "timeout-or-duplicate." Practical concern only if the buyer
 * leaves the form open for 5+ minutes mid-fill.
 */

import { useEffect, useId, useRef, useState } from 'react';

// Cloudflare's loader script — same URL across all sites; safe to
// load once per page even with multiple widgets.
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// Cloudflare's loader sets window.turnstile asynchronously. Use a
// minimal shape — we only need .render().
type TurnstileGlobal = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'compact' | 'flexible';
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      'timeout-callback'?: () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
    // onTurnstileLoaded is the global Cloudflare looks for if we
    // ever switch to render=onload mode. Not used in explicit mode.
    __turnstile_loaded__?: boolean;
  }
}

export type TurnstileWidgetProps = {
  /** Cloudflare site key. When unset, the widget renders nothing
   *  and emits an empty token. */
  siteKey?: string | null;
  /** Fires with the latest token on solve / re-solve. Empty string
   *  on error/expire/unset-sitekey. */
  onToken: (token: string) => void;
  /** Override theme. Defaults to 'dark' to match TurfMap. */
  theme?: 'light' | 'dark' | 'auto';
};

export function TurnstileWidget({
  siteKey,
  onToken,
  theme = 'dark',
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  // Re-renders the widget when siteKey changes (rare, but defensive).
  const renderKey = useId();

  // ─── 1. Load the Cloudflare script once per page ─────────────────
  useEffect(() => {
    if (!siteKey) {
      // No site key configured — short-circuit and tell the parent
      // verification is "off." The backend will mirror this when
      // TURNSTILE_SECRET_KEY is also unset.
      onToken('');
      return;
    }
    if (typeof window === 'undefined') return;
    if (window.turnstile) {
      // Syncing an external system's presence (Cloudflare's loaded
      // SDK) to React state — exactly the case the
      // react-hooks/set-state-in-effect rule's docs allow as the
      // exception. The other set() calls below are in callbacks
      // (script.onload / setInterval), already rule-compliant.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScriptReady(true);
      return;
    }
    if (window.__turnstile_loaded__) return;

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="${TURNSTILE_SCRIPT_SRC.split('?')[0]}"]`
    );
    if (existing) {
      // Another widget instance loaded the script already; poll
      // briefly for window.turnstile to appear.
      const poll = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(poll);
          setScriptReady(true);
        }
      }, 50);
      return () => window.clearInterval(poll);
    }

    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.__turnstile_loaded__ = true;
      setScriptReady(true);
    };
    script.onerror = () => {
      // Loader failed (network, blocker, CSP). Don't strand the
      // form — emit empty token + let backend decide.
      console.warn('[turnstile] script load failed — verification skipped');
      onToken('');
    };
    document.head.appendChild(script);
    // We intentionally don't return a cleanup — the script is a
    // singleton for the page lifetime. Removing it would break
    // subsequent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  // ─── 2. Render the widget once the script is ready ───────────────
  useEffect(() => {
    if (!siteKey || !scriptReady) return;
    if (!containerRef.current) return;
    if (!window.turnstile) return;
    if (widgetIdRef.current) return;

    try {
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme,
        size: 'normal',
        callback: (token: string) => {
          onToken(token);
        },
        'error-callback': () => {
          console.warn('[turnstile] error callback fired');
          onToken('');
        },
        'expired-callback': () => {
          // Cloudflare invalidated the token after ~300s. Clear it;
          // the buyer's next interaction triggers a fresh challenge.
          onToken('');
        },
        'timeout-callback': () => {
          onToken('');
        },
      });
    } catch (e) {
      console.warn(
        '[turnstile] render threw:',
        e instanceof Error ? e.message : String(e)
      );
      onToken('');
    }

    return () => {
      // On unmount, ask Cloudflare to release the widget so its
      // shadow-DOM iframe gets torn down.
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore — remove can throw if the widget was already
          // garbage-collected by Cloudflare's own cleanup
        }
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptReady, siteKey, theme]);

  if (!siteKey) {
    // No site key → nothing to render; parent gets empty token.
    return null;
  }

  return <div ref={containerRef} key={renderKey} />;
}
