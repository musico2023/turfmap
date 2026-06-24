import { Check, AlertTriangle } from 'lucide-react';
import type { GbpScoreResult } from '@/lib/metrics/gbpScore';
import { InfoTooltip } from './InfoTooltip';

/**
 * GBP Optimization Scorecard — Pulse+ dashboard card. Renders the 0–100
 * profile score from lib/metrics/gbpScore plus per-dimension findings
 * (good vs gap) so the operator/client sees concrete "fix your GBP"
 * actions — the lever the AI Coach now leads with for reach-bound
 * businesses. Renders nothing when there's no GBP data (score null).
 */
export function GbpScorecardCard({ result }: { result: GbpScoreResult }) {
  if (result.score === null) return null;
  const score = result.score;
  const band = score >= 80 ? 'Strong' : score >= 50 ? 'Solid' : 'Needs work';
  const color =
    score >= 80 ? 'var(--color-lime)' : score >= 50 ? '#ffb86b' : '#ff6b6b';
  const judged = result.dimensions.filter((d) => d.status !== 'unknown');
  const gaps = judged.filter((d) => d.status === 'gap').length;

  return (
    <div
      className="border rounded-lg p-5"
      style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-display text-lg font-bold flex items-center gap-1.5">
            GBP Optimization
            <InfoTooltip>
              How complete + optimized the Google Business Profile is, scored
              across categories, photos, reviews, rating, hours, and status.
              Higher = a stronger prominence signal for the local pack.
            </InfoTooltip>
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {gaps === 0
              ? 'No gaps — profile is well optimized.'
              : `${gaps} gap${gaps === 1 ? '' : 's'} to close.`}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-display text-3xl font-bold leading-none" style={{ color }}>
            {score}
            <span className="text-zinc-600 text-lg">/100</span>
          </div>
          <div
            className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold mt-1"
            style={{ color }}
          >
            {band}
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {judged.map((d) => {
          const good = d.status === 'good';
          const Icon = good ? Check : AlertTriangle;
          const c = good ? 'var(--color-lime)' : '#ffb86b';
          return (
            <div key={d.key} className="flex items-start gap-2.5">
              <Icon size={14} strokeWidth={good ? 3 : 2} className="flex-shrink-0 mt-0.5" style={{ color: c }} />
              <div className="min-w-0 text-xs leading-relaxed">
                <span className="font-semibold text-zinc-200">{d.label}</span>
                <span className="text-zinc-500"> — {d.detail}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
