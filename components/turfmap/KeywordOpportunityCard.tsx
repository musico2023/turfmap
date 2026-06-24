import { Crosshair, Target } from 'lucide-react';
import type { StrikingDistanceResult } from '@/lib/metrics/strikingDistance';
import type {
  KeywordOpportunityResult,
  KeywordOpportunityTier,
} from '@/lib/metrics/keywordOpportunity';
import { InfoTooltip } from './InfoTooltip';

/**
 * Keyword Opportunity Finder — Pulse+ dashboard card.
 *
 * Two layers: (1) striking distance for the ACTIVE keyword — how many cells
 * sit at rank 4–10, just outside the 3-pack (the quickest wins), which works
 * even for single-keyword locations; (2) a cross-keyword ranking that points
 * at the single keyword to focus next, shown only when the location tracks
 * more than one keyword. Server component.
 */
export function KeywordOpportunityCard({
  activeKeyword,
  striking,
  cross,
}: {
  activeKeyword: string;
  striking: StrikingDistanceResult;
  cross: KeywordOpportunityResult | null;
}) {
  return (
    <div
      className="border rounded-lg p-5"
      style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start gap-2 mb-4">
        <Crosshair size={18} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0 mt-0.5" />
        <h3 className="font-display text-lg font-bold flex items-center gap-1.5">
          Keyword Opportunity
          <InfoTooltip>
            “Striking distance” cells are where you rank 4–10 — just outside the
            3-pack and the quickest to flip. The keyword ranking shows which of
            your tracked queries is closest to breaking through.
          </InfoTooltip>
        </h3>
      </div>

      {/* Striking distance for the active keyword */}
      <div className="mb-1 text-[10px] uppercase tracking-wider font-mono text-zinc-500">
        “{activeKeyword}” — striking distance
      </div>
      <div className="grid grid-cols-3 gap-3 mb-2">
        <Stat value={striking.inPack} label="in the pack" sub="rank 1–3" tone="good" />
        <Stat value={striking.striking} label="striking" sub="rank 4–10" tone="opp" />
        <Stat value={striking.nearPack} label="near pack" sub="rank 4–6" tone="opp" />
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">
        {striking.striking > 0
          ? `${striking.strikingPct}% of your map is one push from the 3-pack` +
            (striking.nearPack > 0
              ? ` — ${striking.nearPack} cell${striking.nearPack === 1 ? '' : 's'} are within two positions.`
              : '.')
          : striking.inPack > 0
            ? `No striking-distance cells — where you're not in the pack, you're well outside it. Expansion comes from new coverage, not nudges.`
            : `This keyword has no map presence yet — it's a build, not a quick win.`}
      </p>

      {/* Cross-keyword ranking — only when >1 keyword tracked */}
      {cross && (
        <div className="mt-5 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-start gap-2 mb-3">
            <Target size={14} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0 mt-0.5" />
            <p className="text-xs text-zinc-300 leading-relaxed font-medium">{cross.headline}</p>
          </div>
          <div className="space-y-1.5">
            {cross.keywords.map((k) => {
              const isTop = cross.topOpportunity?.keyword === k.keyword;
              return (
                <div
                  key={k.keyword}
                  className="flex items-center justify-between gap-3 rounded-md px-3 py-2"
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
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  sub,
  tone,
}: {
  value: number;
  label: string;
  sub: string;
  tone: 'good' | 'opp';
}) {
  const color = tone === 'good' ? 'var(--color-lime)' : '#ffb86b';
  return (
    <div className="rounded-md px-3 py-2.5" style={{ background: '#0b0b0b' }}>
      <div className="font-display text-2xl font-bold leading-none" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] text-zinc-300 mt-1">{label}</div>
      <div className="text-[9px] uppercase tracking-wider font-mono text-zinc-600">{sub}</div>
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
