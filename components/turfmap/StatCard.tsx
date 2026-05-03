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
}: StatCardProps) {
  const hero = variant === 'hero';
  return (
    <div
      className={`border rounded-lg relative ${hero ? 'p-6' : 'p-5'}`}
      style={{
        background: highlight
          ? 'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)'
          : 'var(--color-card)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
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
