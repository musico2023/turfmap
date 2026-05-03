'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'turfmap:show-internals';

export type InternalsFooterProps = {
  scanId: string;
  failedPoints: number;
  dfsCostCents: number;
};

/**
 * Operator-only diagnostic strip — hidden by default behind a "show
 * internals" link, persisted across sessions via localStorage.
 *
 * Why hide it: the strip exposes the per-scan DataForSEO cost which
 * is internal-only info (operator unit economics, not client-facing).
 * Even though this footer only renders on agency-gated pages, leaving
 * it always-on creates clutter for normal client review and risks
 * leaking the cost number into a screenshare or shoulder-surf.
 *
 * Toggle state lives in localStorage so once Anthony enables it for a
 * debugging session, it stays on across page navigations + reloads
 * until he hides it again.
 */
export function InternalsFooter({
  scanId,
  failedPoints,
  dfsCostCents,
}: InternalsFooterProps) {
  const [visible, setVisible] = useState(false);

  // Hydrate from localStorage on mount. SSR renders the hidden state by
  // default — small flicker on toggle-on for sessions where it was
  // previously enabled, but no FOUC of the diagnostic content itself.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setVisible(window.localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  const toggle = () => {
    const next = !visible;
    setVisible(next);
    if (typeof window === 'undefined') return;
    if (next) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  };

  if (!visible) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="text-[10px] font-mono text-zinc-700 hover:text-zinc-500 transition-colors"
      >
        show internals
      </button>
    );
  }

  return (
    <span className="font-mono text-zinc-500 inline-flex items-center gap-2">
      <span>
        Scan {scanId.slice(0, 8)} · {failedPoints} failed pts · $
        {(dfsCostCents / 100).toFixed(2)} DFS
      </span>
      <button
        type="button"
        onClick={toggle}
        className="text-[10px] text-zinc-600 hover:text-zinc-400 underline underline-offset-2"
      >
        hide
      </button>
    </span>
  );
}
