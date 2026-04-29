import type { LucideIcon } from 'lucide-react';

export type StatCardProps = {
  label: string;
  value: string;
  subtitle: string;
  icon: LucideIcon;
  /** Apply the lime accent treatment (used for the headline metric). */
  highlight?: boolean;
};

export function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  highlight,
}: StatCardProps) {
  return (
    <div
      className="border rounded-lg p-5 relative overflow-hidden"
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
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
          {label}
        </div>
        <Icon size={14} className="text-zinc-600" />
      </div>
      <div
        className="font-display text-4xl font-bold mb-1.5 leading-none"
        style={{ color: highlight ? 'var(--color-lime)' : 'white' }}
      >
        {value}
      </div>
      <div className="text-xs text-zinc-500 leading-relaxed">{subtitle}</div>
    </div>
  );
}
