'use client';

import { HelpCircle } from 'lucide-react';

/**
 * Inline help icon with a tooltip that opens on hover (desktop) or
 * focus/tap (touch). Pure CSS — no React state — using `group-focus`
 * + `group-hover` so the same affordance works for mouse, keyboard,
 * and touch users. Tap the icon to open; tap anywhere else to
 * dismiss (focus blurs naturally).
 *
 * Why this matters: the icon previously used `group-hover` only,
 * which means touch users never saw the methodology explanations
 * (TurfScore bands, AMR definition, etc.) since touch doesn't fire
 * hover events. Now it works everywhere.
 *
 * Usage:
 *   <span>AMR <InfoTooltip>Average rank across cells where this brand appeared.</InfoTooltip></span>
 */
export function InfoTooltip({
  children,
  width = 'w-56',
  className = '',
  side = 'bottom',
}: {
  children: React.ReactNode;
  /** Tailwind width class for the tooltip popover. Defaults to w-56 (~14rem). */
  width?: string;
  className?: string;
  /** Which side the tooltip pops out on. */
  side?: 'top' | 'bottom';
}) {
  const sideCls =
    side === 'top'
      ? 'bottom-[calc(100%+6px)]'
      : 'top-[calc(100%+6px)]';
  return (
    <button
      type="button"
      className={`relative inline-flex group cursor-help align-middle p-0 bg-transparent border-0 outline-none focus:outline-none ${className}`}
      aria-label="More info"
    >
      <HelpCircle
        size={11}
        className="text-zinc-600 group-hover:text-zinc-300 group-focus:text-zinc-300 transition-colors"
      />
      <span
        className={`invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 transition-opacity absolute z-50 left-1/2 -translate-x-1/2 ${sideCls} ${width} px-3 py-2 rounded-md text-[11px] font-normal text-zinc-300 bg-zinc-900 border border-zinc-700 shadow-xl whitespace-normal leading-relaxed pointer-events-none normal-case tracking-normal text-left`}
      >
        {children}
      </span>
    </button>
  );
}
