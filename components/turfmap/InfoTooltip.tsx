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
  align = 'center',
}: {
  children: React.ReactNode;
  /** Tailwind width class for the tooltip popover. Defaults to w-56 (~14rem). */
  width?: string;
  className?: string;
  /** Which side the tooltip pops out on. */
  side?: 'top' | 'bottom';
  /**
   * Horizontal anchor for the tooltip relative to the trigger icon:
   *
   *   - 'center' (default): tooltip's center aligns with the trigger.
   *     Best when the trigger has at least `width / 2` of horizontal
   *     space on each side. Overflows the viewport when used in
   *     right-edge layouts (e.g. the rightmost column of a card).
   *   - 'right': tooltip's right edge aligns with the trigger's right
   *     edge — the tooltip extends leftward only. Use this for
   *     triggers in the rightmost column of a container so the
   *     tooltip can't bleed off-screen.
   *   - 'left': mirror — tooltip's left edge aligns with the
   *     trigger's left edge. Use for leftmost-column triggers if
   *     they ever overflow on narrow viewports.
   */
  align?: 'left' | 'center' | 'right';
}) {
  const sideCls =
    side === 'top'
      ? 'bottom-[calc(100%+6px)]'
      : 'top-[calc(100%+6px)]';
  const alignCls =
    align === 'right'
      ? 'right-0'
      : align === 'left'
        ? 'left-0'
        : 'left-1/2 -translate-x-1/2';
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
        className={`invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 transition-opacity absolute z-50 ${alignCls} ${sideCls} ${width} px-3 py-2 rounded-md text-[11px] font-normal text-zinc-300 bg-zinc-900 border border-zinc-700 shadow-xl whitespace-normal leading-relaxed pointer-events-none normal-case tracking-normal text-left`}
      >
        {children}
      </span>
    </button>
  );
}
