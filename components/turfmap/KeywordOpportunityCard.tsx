import { Crosshair } from 'lucide-react';
import type {
  KeywordOpportunityResult,
  KeywordOpportunityTier,
} from '@/lib/metrics/keywordOpportunity';
import { InfoTooltip } from './InfoTooltip';

/**
 * Keyword Opportunity Finder — Pulse+ dashboard card.
 *
 * Ranks the keywords a location tracks by how winnable they are — using the
 * latest reach/score per keyword — and names the single one to focus next,
 * so effort concentrates on the query closest to breaking into the 3-pack
 * instead of spreading evenly. Shown only when the location tracks more than
 * one keyword (nothing to compare otherwise). Server component.
 *
 * Note: we deliberately don't show a per-cell "striking distance" (rank
 * 4–10) metric — the Local Pack scan only returns pack positions (1–3, the
 * occasional 4), so ranks below the pack are unmeasured. Reach is the honest
 * signal we have.
 */
export function KeywordOpportunityCard({ result }: { result: KeywordOpportunityResult }) {
  return (
    <div
      className="border rounded-lg p-5"
      style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start gap-2 mb-2">
        <Crosshair size={18} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0 mt-0.5" />
        <h3 className="font-display text-lg font-bold flex items-center gap-1.5">
          Keyword Opportunity
          <InfoTooltip>
            Your tracked keywords ranked by how winnable they are. Reach = % of
            your 81-cell map in the 3-pack. The card points at the query closest
            to breaking through, and flags any stuck at zero.
          </InfoTooltip>
        </h3>
      </div>

      <p className="text-xs text-zinc-400 mb-4 leading-relaxed">{result.headline}</p>

      <div className="space-y-1.5">
        {result.keywords.map((k) => {
          const isTop = result.topOpportunity?.keyword === k.keyword;
          return (
            <div
              key={k.keyword}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5"
              style={{
                background: isTop ? 'rgba(197,255,58,0.06)' : '#0b0b0b',
                border: isTop ? '1px solid rgba(197,255,58,0.25)' : '1px solid transparent',
              }}
            >
              <div className="min-w-0 flex items-center gap-2">
                <span className="text-xs text-zinc-200 truncate" title={k.keyword}>
                  {k.keyword}
                </span>
                {k.isPrimary && (
                  <span className="text-[9px] uppercase tracking-wider font-mono text-zinc-500 flex-shrink-0">
                    primary
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="font-mono text-xs text-zinc-400 tabular-nums">
                  {k.turfReach ?? 0}% reach
                </span>
                <TierBadge tier={k.tier} label={k.label} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TIER_COLOR: Record<KeywordOpportunityTier, { fg: string; bg: string }> = {
  defend: { fg: 'var(--color-lime)', bg: 'rgba(197,255,58,0.1)' },
  push: { fg: '#ffb86b', bg: 'rgba(255,184,107,0.12)' },
  build: { fg: '#7ca8c4', bg: 'rgba(124,168,196,0.12)' },
  reconsider: { fg: '#ff6b6b', bg: 'rgba(255,107,107,0.1)' },
};

function TierBadge({ tier, label }: { tier: KeywordOpportunityTier; label: string }) {
  const c = TIER_COLOR[tier];
  return (
    <span
      className="text-[9px] uppercase tracking-wider font-mono font-semibold px-2 py-1 rounded whitespace-nowrap"
      style={{ color: c.fg, background: c.bg }}
    >
      {label}
    </span>
  );
}
