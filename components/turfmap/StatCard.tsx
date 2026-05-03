import type { LucideIcon } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';
import type { TurfScoreBandTone } from '@/lib/metrics/turfScoreBands';

export type StatCardProps = {
  label: string;
  value: string;
  subtitle: string;
  icon: LucideIcon;
  /** Apply the lime accent treatment (used for the headline metric). */
  highlight?: boolean;
  /** Optional methodology tooltip rendered next to the label. */
  tooltip?: React.ReactNode;
  /** Render large — used for the headline TurfScore card. */
  variant?: 'standard' | 'hero';
  /** Categorical band label rendered between value and subtitle, with
   *  tone-driven color. Used on the TurfScore hero card. */
  band?: {
    label: string;
    tone: TurfScoreBandTone;
  };
  /** 0–100 fill percentage. When provided on the `hero` variant, renders
   *  a thin lime vertical bar on the card's left edge — a redundant
   *  visualization of the headline number that reads as a meter. The
   *  bar's height is `fillPct%` of the inner card height, drawn
   *  bottom-aligned so empty space sits at the top (lower scores look
   *  visibly low). */
  fillPct?: number | null;
};

export function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  highlight,
  tooltip,
  variant = 'standard',
  band,
  fillPct,
}: StatCardProps) {
  const hero = variant === 'hero';
  const showFill =
    hero && typeof fillPct === 'number' && Number.isFinite(fillPct);
  const clampedFill = showFill
    ? Math.max(0, Math.min(100, fillPct as number))
    : 0;
  return (
    <div
      className={`border rounded-lg relative overflow-hidden ${hero ? 'p-6' : 'p-5'}`}
      style={{
        background: highlight
          ? 'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)'
          : 'var(--color-card)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      {showFill && (
        // Vertical scope-readout meter pinned to the inside-left edge of
        // the card. Bottom-aligned (filling upward as the score climbs)
        // so a low score reads as visually low rather than as a stalk
        // floating mid-card. Uses the brand lime + a soft glow rather
        // than a hard rectangle so it reads as an indicator, not chrome.
        <div
          className="absolute left-0 top-0 bottom-0 w-1 pointer-events-none"
          aria-hidden
        >
          <div
            className="absolute left-0 right-0 bottom-0 transition-[height] duration-700 ease-out"
            style={{
              height: `${clampedFill}%`,
              background:
                'linear-gradient(to top, var(--color-lime) 0%, #c5ff3acc 100%)',
              boxShadow: '0 0 12px #c5ff3a55',
            }}
          />
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        {/* Score names render as written (PascalCase, no space) — no
         *  CSS uppercase transform. Other in-app labels (column
         *  headers, etc.) have their own styling and stay uppercase. */}
        <div className="flex items-center gap-1.5 text-xs tracking-tight text-zinc-400 font-semibold">
          {label}
          {tooltip && <InfoTooltip>{tooltip}</InfoTooltip>}
        </div>
        <Icon size={hero ? 16 : 14} className="text-zinc-600" />
      </div>
      <div
        className={`font-display font-bold leading-none ${
          hero ? 'text-6xl mb-2.5' : 'text-4xl mb-1.5'
        }`}
        style={{ color: highlight ? 'var(--color-lime)' : 'white' }}
      >
        {value}
      </div>
      {band && (
        <div
          className="text-sm font-bold mb-1.5"
          style={{ color: bandColor(band.tone) }}
        >
          {band.label}
        </div>
      )}
      <div className="text-xs text-zinc-500 leading-relaxed">{subtitle}</div>
    </div>
  );
}

/**
 * Map TurfScore band tone → text color. Single source of truth so the
 * band label color is consistent everywhere it renders. Lime / green for
 * top tiers (matches brand accent), red/orange for the alarm tiers.
 */
function bandColor(tone: TurfScoreBandTone): string {
  switch (tone) {
    case 'critical':
      return '#ff4d4d'; // red — Invisible
    case 'weak':
      return '#ff9f3a'; // orange — Patchy
    case 'solid':
      return '#e8e54a'; // amber — Solid
    case 'strong':
      return 'var(--color-lime)'; // lime — Dominant
    case 'elite':
      return 'var(--color-lime)'; // lime — Rare air
    default:
      return '#a1a1aa';
  }
}
