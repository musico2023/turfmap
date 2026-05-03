/**
 * Tabular history of every scan for a client. Rows are clickable into the
 * per-scan permalink page. Action column links to the PDF.
 */

import Link from 'next/link';
import { ChevronRight, Download, Sparkles } from 'lucide-react';

export type ScanHistoryRow = {
  id: string;
  scanType: 'scheduled' | 'on_demand';
  status: 'queued' | 'running' | 'complete' | 'failed';
  completedAt: string | null;
  createdAt: string | null;
  /** Composite TurfScore (0..100) from scans.turf_score. */
  turfScore: number | null;
  /** TurfReach (0..100%) from scans.turf_reach. */
  turfReach: number | null;
  /** TurfRank (0..3) from scans.turf_rank. */
  turfRank: number | null;
  /** Signed momentum vs. previous scan from scans.momentum. */
  momentum: number | null;
  failedPoints: number | null;
  totalPoints: number | null;
  hasInsight: boolean;
};

export type ScanHistoryTableProps = {
  clientId: string;
  rows: ScanHistoryRow[];
};

export function ScanHistoryTable({
  clientId,
  rows,
}: ScanHistoryTableProps) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border p-8 text-center text-sm text-zinc-500"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        No scans yet.
      </div>
    );
  }

  return (
    <div
      className="rounded-md border overflow-hidden"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-[10px] uppercase tracking-[0.18em] text-zinc-500"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <th className="text-left font-semibold px-4 py-3">Date (UTC)</th>
            <th className="text-left font-semibold px-4 py-3">Type</th>
            <th className="text-right font-semibold px-4 py-3">TurfScore</th>
            <th className="text-right font-semibold px-4 py-3">Reach</th>
            <th className="text-right font-semibold px-4 py-3">Rank</th>
            <th className="text-right font-semibold px-4 py-3">Momentum</th>
            <th className="text-right font-semibold px-4 py-3">Failed</th>
            <th className="text-center font-semibold px-4 py-3">Coach</th>
            <th className="text-right font-semibold px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {rows.map((r) => {
            const isComplete = r.status === 'complete';
            const dateStr = r.completedAt
              ? new Date(r.completedAt).toISOString().slice(0, 16).replace('T', ' ')
              : r.createdAt
                ? `${new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')} (no completion)`
                : '—';
            const momentumDisplay =
              r.momentum === null || r.momentum === undefined
                ? '—'
                : `${r.momentum > 0 ? '+' : ''}${r.momentum}`;
            const momentumColor =
              r.momentum === null || r.momentum === undefined
                ? '#71717a'
                : r.momentum > 0
                  ? 'var(--color-lime)'
                  : r.momentum < 0
                    ? '#ff4d4d'
                    : '#a1a1aa';

            return (
              <tr
                key={r.id}
                className="hover:bg-zinc-900/40 transition-colors"
                style={{ borderTop: '1px solid var(--color-border)' }}
              >
                <td className="px-4 py-3 text-zinc-300">{dateStr}</td>
                <td className="px-4 py-3">
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider"
                    style={{
                      background:
                        r.scanType === 'scheduled' ? '#1a2010' : '#0a0a0a',
                      color:
                        r.scanType === 'scheduled'
                          ? 'var(--color-lime)'
                          : '#a1a1aa',
                      border: `1px solid ${r.scanType === 'scheduled' ? 'var(--color-border-bright)' : 'var(--color-border)'}`,
                    }}
                  >
                    {r.scanType === 'scheduled' ? 'cron' : 'on-demand'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-zinc-200">
                  {r.turfScore === null ? '—' : r.turfScore}
                </td>
                <td className="px-4 py-3 text-right text-zinc-200">
                  {r.turfReach === null ? '—' : `${Number(r.turfReach)}%`}
                </td>
                <td className="px-4 py-3 text-right text-zinc-200">
                  {r.turfRank === null
                    ? '—'
                    : `${Number(r.turfRank).toFixed(1)} / 3`}
                </td>
                <td
                  className="px-4 py-3 text-right font-semibold"
                  style={{ color: momentumColor }}
                >
                  {momentumDisplay}
                </td>
                <td className="px-4 py-3 text-right text-zinc-500">
                  {r.failedPoints === null
                    ? '—'
                    : `${r.failedPoints}/${r.totalPoints ?? 81}`}
                </td>
                <td className="px-4 py-3 text-center">
                  {r.hasInsight ? (
                    <Sparkles
                      size={12}
                      style={{ color: 'var(--color-lime)' }}
                      className="inline"
                    />
                  ) : (
                    <span className="text-zinc-700">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {isComplete && (
                      <a
                        href={`/api/reports/pdf?scanId=${r.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Download PDF"
                        className="text-zinc-500 hover:text-zinc-200 transition-colors"
                      >
                        <Download size={13} />
                      </a>
                    )}
                    <Link
                      href={`/clients/${clientId}/scans/${r.id}`}
                      className="text-zinc-500 hover:text-zinc-200 transition-colors flex items-center gap-1"
                    >
                      view
                      <ChevronRight size={12} />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
