/**
 * Tabular history of every scan for a client. Rows are clickable into the
 * per-scan permalink page. Action column links to the PDF.
 */

import Link from 'next/link';
import { ChevronRight, Download, Sparkles } from 'lucide-react';
import { turfScoreDisplay } from '@/lib/metrics/turfScoreDisplay';

export type ScanHistoryRow = {
  id: string;
  scanType: 'scheduled' | 'on_demand';
  status: 'queued' | 'running' | 'complete' | 'failed';
  completedAt: string | null;
  createdAt: string | null;
  turfScore: number | null;
  top3WinRate: number | null;
  turfRadiusUnits: number | null;
  failedPoints: number | null;
  totalPoints: number | null;
  hasInsight: boolean;
};

export type ScanHistoryTableProps = {
  clientId: string;
  rows: ScanHistoryRow[];
  /** Client's configured service radius in miles. Used to convert
   *  turf_radius_units (rings) → miles. Defaults to the v1 default. */
  serviceRadiusMiles?: number;
};

export function ScanHistoryTable({
  clientId,
  rows,
  serviceRadiusMiles = 1.6,
}: ScanHistoryTableProps) {
  const milesPerRing = serviceRadiusMiles / 4;
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
            <th className="text-right font-semibold px-4 py-3">Radius</th>
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
            const radius =
              r.turfRadiusUnits === null
                ? '—'
                : `${(r.turfRadiusUnits * milesPerRing).toFixed(1)}mi`;

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
                  {r.turfScore === null
                    ? '—'
                    : `${turfScoreDisplay(r.turfScore)}`}
                </td>
                <td className="px-4 py-3 text-right text-zinc-200">
                  {r.top3WinRate === null ? '—' : `${Number(r.top3WinRate)}%`}
                </td>
                <td className="px-4 py-3 text-right text-zinc-200">{radius}</td>
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
