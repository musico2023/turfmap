import { HelpCircle } from 'lucide-react';

/**
 * Inline help icon with a hover tooltip. Pure CSS (no JS state) — relies on
 * Tailwind's `group-hover:` utilities. The tooltip is `pointer-events-none`
 * so moving the cursor onto it doesn't break the parent's `:hover`.
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
    <span
      className={`relative inline-flex group cursor-help align-middle ${className}`}
    >
      <HelpCircle
        size={11}
        className="text-zinc-600 group-hover:text-zinc-300 transition-colors"
      />
      <span
        className={`invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute z-50 left-1/2 -translate-x-1/2 ${sideCls} ${width} px-3 py-2 rounded-md text-[11px] font-normal text-zinc-300 bg-zinc-900 border border-zinc-700 shadow-xl whitespace-normal leading-relaxed pointer-events-none normal-case tracking-normal`}
      >
        {children}
      </span>
    </span>
  );
}
