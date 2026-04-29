/**
 * AI Coach panel — server component.
 *
 * Reads the most recent ai_insights row for the given scan (if any) and
 * renders the diagnosis + 3 prioritized actions + projected impact, matching
 * the prototype layout. The "Generate playbook" trigger is a thin client
 * subcomponent (AICoachGenerateButton) so the page stays SSR by default.
 */

import { ChevronRight, Sparkles, TrendingUp } from 'lucide-react';
import { AICoachGenerateButton } from './AICoachGenerateButton';

export type AICoachAction = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  action: string;
  why: string;
};

export type AICoachProps = {
  scanId: string | null;
  /** Existing insight, if one was already generated for this scan. */
  insight: {
    diagnosis: string;
    actions: AICoachAction[];
    projected_impact: string | null;
  } | null;
  /** Disable the generate button when there's no scan yet. */
  scanComplete: boolean;
};

export function AICoach({ scanId, insight, scanComplete }: AICoachProps) {
  return (
    <div
      className="rounded-lg p-6 relative overflow-hidden border"
      style={{
        background:
          'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        borderColor: insight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div
        className="absolute top-0 right-0 w-96 h-96 rounded-full opacity-10 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, var(--color-lime), transparent 70%)',
          transform: 'translate(30%, -30%)',
        }}
      />

      <div className="flex items-start justify-between mb-5 relative">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Sparkles size={16} style={{ color: 'var(--color-lime)' }} />
            <h3 className="font-display text-xl font-bold">TurfMap AI Coach</h3>
            <span
              className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded border"
              style={{
                background: '#1a2010',
                color: 'var(--color-lime)',
                borderColor: '#2d3a14',
              }}
            >
              Powered by Claude
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            Strategic recommendations generated from your live heatmap data
          </p>
        </div>
        {scanComplete && !insight && scanId && (
          <AICoachGenerateButton scanId={scanId} />
        )}
      </div>

      {!scanComplete && (
        <div className="text-sm text-zinc-600 italic">
          Run a TurfScan to unlock AI-powered strategic recommendations.
        </div>
      )}

      {scanComplete && !insight && (
        <div className="text-sm text-zinc-500">
          81 data points captured. Generate playbook to receive prioritized
          actions.
        </div>
      )}

      {insight && (
        <>
          <div
            className="border-l-2 pl-4 mb-5"
            style={{ borderColor: 'var(--color-lime)' }}
          >
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1 font-semibold">
              Diagnosis
            </div>
            <p className="text-sm text-zinc-200 leading-relaxed">
              {insight.diagnosis}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-5">
            {insight.actions.map((action, i) => (
              <div
                key={i}
                className="border rounded-lg p-4 transition-colors"
                style={{
                  background: '#0a0a0a',
                  borderColor: 'var(--color-border)',
                }}
              >
                <div className="flex items-center justify-between mb-2.5">
                  <span
                    className="text-[10px] font-mono uppercase font-bold tracking-widest px-2 py-0.5 rounded"
                    style={{
                      background:
                        action.priority === 'HIGH'
                          ? 'var(--color-lime)'
                          : action.priority === 'MEDIUM'
                            ? '#ff9f3a'
                            : '#3a3a3a',
                      color: action.priority === 'LOW' ? '#999' : 'black',
                    }}
                  >
                    {action.priority}
                  </span>
                  <span className="font-mono text-xs text-zinc-700">
                    #{i + 1}
                  </span>
                </div>
                <h4 className="text-sm font-semibold text-zinc-100 mb-2 leading-snug">
                  {action.action}
                </h4>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  {action.why}
                </p>
              </div>
            ))}
          </div>

          {insight.projected_impact && (
            <div
              className="text-xs text-zinc-300 flex items-start gap-2 pt-4 border-t"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <TrendingUp
                size={14}
                style={{ color: 'var(--color-lime)' }}
                className="mt-0.5 flex-shrink-0"
              />
              <span>
                <span className="text-zinc-500 font-semibold uppercase tracking-wider text-[10px] mr-1.5">
                  Projected impact:
                </span>
                {insight.projected_impact}
              </span>
            </div>
          )}
        </>
      )}

      {scanComplete && !insight && scanId && (
        <div className="mt-4 text-[10px] text-zinc-700 font-mono flex items-center gap-1">
          <span>Powered by Claude Sonnet 4.6 · ~$0.05 / generation</span>
          <ChevronRight size={10} className="text-zinc-700" />
        </div>
      )}
    </div>
  );
}
