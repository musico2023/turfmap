import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';
import { momentumCaption } from '@/lib/metrics/momentum';

/**
 * Momentum card — secondary metric showing change in TurfScore vs. the
 * previous scan. Special-cased styling (directional color + arrow icon)
 * separate from the standard StatCard family because the value semantics
 * are different (signed integer with a "neutral zero" treatment).
 *
 * Empty state (first scan, momentum is null) renders "—" with a caption
 * about unlocking at the 90-day re-scan. The card should be hidden
 * entirely on first scans, but is rendered defensively here in case a
 * caller forgets the conditional — the empty state is at least
 * self-explanatory.
 */
export function MomentumCard({
  momentum,
}: {
  momentum: number | null;
}) {
  const empty = momentum === null || momentum === undefined;
  const positive = !empty && momentum! > 0;
  const negative = !empty && momentum! < 0;
  const zero = !empty && momentum === 0;

  const color = positive
    ? 'var(--color-lime)'
    : negative
      ? '#ff4d4d'
      : '#a1a1aa';

  const Arrow = positive
    ? ArrowUp
    : negative
      ? ArrowDown
      : zero
        ? Minus
        : ArrowRight;

  const valueText = empty
    ? '—'
    : `${momentum! > 0 ? '+' : ''}${momentum}`;

  return (
    <div
      className="border rounded-lg p-5 relative"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-xs tracking-tight text-zinc-400 font-semibold">
          Momentum™
          <InfoTooltip>
            The change in your TurfScore since your previous scan.
            Positive numbers mean your visibility is expanding. Updates
            every 90 days.
          </InfoTooltip>
        </div>
        <Arrow size={14} style={{ color }} />
      </div>
      <div
        className="font-display text-4xl font-bold leading-none mb-1.5"
        style={{ color: empty ? 'white' : color }}
      >
        {valueText}
      </div>
      <div className="text-xs text-zinc-500 leading-relaxed">
        {momentumCaption(momentum ?? null)}
      </div>
    </div>
  );
}
