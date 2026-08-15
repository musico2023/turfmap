import { Swords, TrendingUp, TrendingDown } from 'lucide-react';
import type { CompetitorIntelResult } from '@/lib/metrics/competitorIntel';
import { InfoTooltip } from './InfoTooltip';

/**
 * Competitor Intel — Pulse+ dashboard card. Pins the client's own line at
 * the top, then lists the top competitors by grid share with their AMR,
 * rating, and review count, plus the gap vs the client (the reviews/rating
 * lever the AI Coach leads with). Renders nothing when no competitor holds
 * meaningful share. Server component.
 */
export function CompetitorIntelCard({ result }: { result: CompetitorIntelResult }) {
  const { own, competitors, headline } = result;

  return (
    <div
      className="border rounded-lg p-5"
      style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start gap-2 mb-1">
        <Swords size={18} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0 mt-0.5" />
        <h3 className="font-display text-lg font-bold flex items-center gap-1.5">
          Competitor Intel
          <InfoTooltip>
            Your top rivals on this keyword, ranked by how much of your 81-cell
            map they hold. AMR = average rank where they appear (1 = top of the
            pack). The gaps show what separates you — usually reviews.
          </InfoTooltip>
        </h3>
      </div>
      <p className="text-xs text-zinc-400 mb-4 leading-relaxed">{headline}</p>

      <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500" style={{ background: '#0b0b0b' }}>
              <th className="py-2 px-3 font-mono font-medium">Business</th>
              <th className="py-2 px-3 font-mono font-medium text-right">Map share</th>
              <th className="py-2 px-3 font-mono font-medium text-right">AMR</th>
              <th className="py-2 px-3 font-mono font-medium text-right">Reviews</th>
              <th className="py-2 px-3 font-mono font-medium text-right">Rating</th>
            </tr>
          </thead>
          <tbody>
            {/* Client's own anchor row */}
            <tr
              className="border-t"
              style={{ borderColor: 'var(--color-border)', background: 'rgba(197,255,58,0.06)' }}
            >
              <td className="py-2.5 px-3 font-semibold" style={{ color: 'var(--color-lime)' }}>
                You
              </td>
              <td className="py-2.5 px-3 text-right font-mono text-zinc-200">{own.sharePct}%</td>
              <td className="py-2.5 px-3 text-right font-mono text-zinc-200">{fmtAmr(own.amr)}</td>
              <td className="py-2.5 px-3 text-right font-mono text-zinc-200">{fmtNum(own.reviews)}</td>
              <td className="py-2.5 px-3 text-right font-mono text-zinc-200">{fmtRating(own.rating)}</td>
            </tr>

            {competitors.map((c) => (
              <tr key={c.name} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                <td className="py-2.5 px-3 text-zinc-200 max-w-[180px] truncate" title={c.name}>
                  {c.name}
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-zinc-300">
                  {c.sharePct}%
                  <GapBadge value={c.shareGap} unit="pp" higherIsBad />
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-zinc-300">{c.amr.toFixed(1)}</td>
                <td className="py-2.5 px-3 text-right font-mono text-zinc-300">
                  {fmtNum(c.reviews)}
                  <GapBadge value={c.reviewGap} higherIsBad />
                </td>
                <td className="py-2.5 px-3 text-right font-mono text-zinc-300">{fmtRating(c.rating)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Small inline delta vs the client. `higherIsBad` flips the color so a
 *  competitor leading (positive gap) renders amber, trailing renders lime. */
function GapBadge({
  value,
  unit = '',
  higherIsBad = false,
}: {
  value: number | null;
  unit?: string;
  higherIsBad?: boolean;
}) {
  if (value == null || value === 0) return null;
  const ahead = higherIsBad ? value > 0 : value < 0; // competitor ahead of client
  const color = ahead ? '#ffb86b' : 'var(--color-lime)';
  const Icon = value > 0 ? TrendingUp : TrendingDown;
  const mag = Math.abs(value);
  return (
    <span className="inline-flex items-center gap-0.5 ml-1.5 text-[10px]" style={{ color }}>
      <Icon size={10} />
      {value > 0 ? '+' : '−'}
      {mag.toLocaleString()}
      {unit}
    </span>
  );
}

function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString();
}
function fmtRating(r: number | null): string {
  return r == null ? '—' : `${r.toFixed(1)}★`;
}
/** Null AMR means the client holds no cells at all — there's no rank to
 *  average, which is different from "0". Render it like any other
 *  unknown so the row never implies a measured value. */
function fmtAmr(a: number | null): string {
  return a == null ? '—' : a.toFixed(1);
}
