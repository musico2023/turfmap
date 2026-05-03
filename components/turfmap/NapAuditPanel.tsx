'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Radio,
  XCircle,
} from 'lucide-react';
import type {
  NapAuditFindings,
  NapAuditRow,
  NapAuditStatus,
} from '@/lib/supabase/types';

/** Lightweight row used for the history list — we don't need the full
 *  audit row until the operator expands one. */
export type NapAuditSummaryRow = {
  id: string;
  status: NapAuditStatus;
  created_at: string | null;
  completed_at: string | null;
  total_citations: number | null;
  inconsistencies_count: number | null;
  missing_high_priority_count: number | null;
  error_message: string | null;
};

/**
 * Operator-only NAP audit panel.
 *
 * - "Run audit" calls POST /api/nap/audit/[clientId] and inserts a new row.
 * - For audits in `running` state, the panel auto-polls
 *   GET /api/nap/audit/[clientId]/[auditId] every POLL_MS until the row
 *   transitions to `complete` or `failed`.
 * - Expanding a `complete` row pulls its full findings on demand.
 *
 * Polling lives client-side (not Vercel cron) on purpose: NAP audits are
 * rare and the operator is already on the page when one's running.
 */
export function NapAuditPanel({
  clientId,
  initialAudits,
  napFieldsComplete,
}: {
  clientId: string;
  initialAudits: NapAuditSummaryRow[];
  /** True iff the client has all structured NAP fields filled in. The
   *  Run button is disabled otherwise — POST would 400 anyway. */
  napFieldsComplete: boolean;
}) {
  const [audits, setAudits] = useState<NapAuditSummaryRow[]>(initialAudits);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRun = useCallback(async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`/api/nap/audit/${clientId}`, {
        method: 'POST',
      });
      const data = (await res.json()) as {
        auditId?: string;
        status?: string;
        requestCount?: number;
        rejectedCount?: number;
        error?: string;
      };
      if (!res.ok || !data.auditId) {
        setError(data.error ?? `audit failed (HTTP ${res.status})`);
        return;
      }
      // Optimistically prepend the new row. The first poll cycle will
      // fill in totals/findings.
      setAudits((prev) => [
        {
          id: data.auditId!,
          status: (data.status as NapAuditStatus) ?? 'running',
          created_at: new Date().toISOString(),
          completed_at: null,
          total_citations: null,
          inconsistencies_count: null,
          missing_high_priority_count: null,
          error_message: null,
        },
        ...prev,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [clientId]);

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">Citation NAP audit</h3>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-xl">
            Scans 15 directories via BrightLocal and reports inconsistencies in
            the business name, address, or phone. Operator-only — feeds the AI
            Coach prompt; not surfaced in the client portal. Rate-limited to 4
            audits per 30 days.
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running || !napFieldsComplete}
          className="px-4 py-2 rounded-md font-bold text-xs flex items-center gap-1.5 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
            boxShadow: '0 4px 16px #c5ff3a30',
          }}
        >
          {running ? (
            <>
              <Activity size={12} className="animate-pulse" /> Starting…
            </>
          ) : (
            <>
              <Radio size={12} /> Run audit
            </>
          )}
        </button>
      </div>

      {!napFieldsComplete && (
        <div
          className="border rounded-md p-3 mb-4 text-xs flex items-start gap-2"
          style={{
            background: '#1a1303',
            borderColor: '#3f2a05',
            color: '#f5d56e',
          }}
        >
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            Fill in the structured NAP fields (phone, street, city, state, ZIP)
            on the{' '}
            <a
              href={`/clients/${clientId}/settings`}
              className="underline hover:no-underline"
            >
              settings page
            </a>{' '}
            before running an audit.
          </span>
        </div>
      )}

      {error && (
        <div
          className="border rounded-md p-3 mb-4 text-xs flex items-start gap-2"
          style={{
            background: '#1a0606',
            borderColor: '#3f0a0a',
            color: '#f87171',
          }}
        >
          <XCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="font-mono">{error}</span>
        </div>
      )}

      {audits.length === 0 ? (
        <p className="text-xs text-zinc-600 italic">
          No audits yet. Run one to see citation health across directories.
        </p>
      ) : (
        <ul className="space-y-2">
          {audits.map((row) => (
            <AuditRow
              key={row.id}
              clientId={clientId}
              row={row}
              onUpdate={(updated) =>
                setAudits((prev) =>
                  prev.map((r) => (r.id === updated.id ? updated : r))
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const POLL_MS = 10_000;

function AuditRow({
  clientId,
  row,
  onUpdate,
}: {
  clientId: string;
  row: NapAuditSummaryRow;
  onUpdate: (next: NapAuditSummaryRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [findings, setFindings] = useState<NapAuditFindings | null>(null);
  const [loadingFindings, setLoadingFindings] = useState(false);
  const [progress, setProgress] = useState<{ ready: number; total: number } | null>(
    null
  );

  const poll = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoadingFindings(true);
      try {
        const res = await fetch(`/api/nap/audit/${clientId}/${row.id}`);
        const data = (await res.json()) as {
          audit?: NapAuditRow;
          progress?: { ready: number; total: number };
          error?: string;
        };
        if (!res.ok || !data.audit) return;
        const a = data.audit;
        onUpdate({
          id: a.id,
          status: a.status,
          created_at: a.created_at,
          completed_at: a.completed_at,
          total_citations: a.total_citations,
          inconsistencies_count: a.inconsistencies_count,
          missing_high_priority_count: a.missing_high_priority_count,
          error_message: a.error_message,
        });
        if (a.findings) setFindings(a.findings);
        if (data.progress) setProgress(data.progress);
      } finally {
        if (!opts.silent) setLoadingFindings(false);
      }
    },
    [clientId, row.id, onUpdate]
  );

  // Auto-poll while running. Cleared as soon as status flips to terminal.
  useEffect(() => {
    if (row.status !== 'running' && row.status !== 'pending') return;
    const id = setInterval(() => poll({ silent: true }), POLL_MS);
    // Fire one immediately so the dashboard moves quickly on first paint.
    poll({ silent: true });
    return () => clearInterval(id);
  }, [row.status, poll]);

  const onToggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !findings && row.status === 'complete') {
      await poll();
    }
  };

  const created = row.created_at ? new Date(row.created_at) : null;

  return (
    <li
      className="border rounded-md"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors rounded-md"
      >
        <StatusBadge status={row.status} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-zinc-300">
            {created
              ? created.toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : 'Unknown date'}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {row.status === 'complete' && (
              <>
                <Pill>{row.total_citations ?? 0} citations</Pill>
                <Pill>{row.inconsistencies_count ?? 0} inconsistencies</Pill>
                <Pill>
                  {row.missing_high_priority_count ?? 0} high-priority missing
                </Pill>
              </>
            )}
            {(row.status === 'running' || row.status === 'pending') &&
              progress && (
                <span className="font-mono">
                  {progress.ready} / {progress.total} directories ready
                </span>
              )}
            {row.status === 'failed' && row.error_message && (
              <span className="font-mono text-red-400">
                {row.error_message}
              </span>
            )}
          </div>
        </div>
        {row.status === 'complete' &&
          (expanded ? (
            <ChevronDown size={14} className="text-zinc-500" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500" />
          ))}
      </button>

      {expanded && row.status === 'complete' && (
        <div
          className="border-t px-3 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {loadingFindings && !findings ? (
            <p className="text-xs text-zinc-500 font-mono">Loading findings…</p>
          ) : findings ? (
            <FindingsDetail findings={findings} />
          ) : (
            <p className="text-xs text-zinc-500 italic">
              No findings data on this row.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: NapAuditStatus }) {
  const map: Record<
    NapAuditStatus,
    { label: string; bg: string; fg: string; icon: React.ReactNode }
  > = {
    pending: {
      label: 'Pending',
      bg: '#1a1a1a',
      fg: '#a1a1aa',
      icon: <Activity size={10} className="animate-pulse" />,
    },
    running: {
      label: 'Running',
      bg: '#0d1c2a',
      fg: '#7dd3fc',
      icon: <Activity size={10} className="animate-pulse" />,
    },
    complete: {
      label: 'Complete',
      bg: '#0a1f0d',
      fg: '#a3e635',
      icon: <CheckCircle2 size={10} />,
    },
    failed: {
      label: 'Failed',
      bg: '#1a0606',
      fg: '#f87171',
      icon: <XCircle size={10} />,
    },
  };
  const s = map[status];
  return (
    <span
      className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-bold flex items-center gap-1 flex-shrink-0"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.icon} {s.label}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block mr-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/5 text-zinc-400">
      {children}
    </span>
  );
}

function FindingsDetail({ findings }: { findings: NapAuditFindings }) {
  const { citations, inconsistencies, missing } = findings;
  return (
    <div className="space-y-4">
      {inconsistencies.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-2">
            Inconsistencies ({inconsistencies.length})
          </h4>
          <ul className="space-y-1.5">
            {inconsistencies.map((i, idx) => (
              <li
                key={`${i.directory}-${i.field}-${idx}`}
                className="text-xs text-zinc-400 font-mono flex items-start gap-2"
              >
                <span className="text-zinc-600 uppercase text-[10px] flex-shrink-0 mt-0.5 w-16">
                  {i.field}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-zinc-500">
                    {i.directory}:&nbsp;
                  </span>
                  <span className="text-red-400">
                    &ldquo;{i.found}&rdquo;
                  </span>
                  <span className="text-zinc-600"> ≠ </span>
                  <span className="text-zinc-300">
                    &ldquo;{i.canonical}&rdquo;
                  </span>
                  {i.citation_url && (
                    <a
                      href={i.citation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 inline-flex items-center text-zinc-600 hover:text-zinc-300"
                    >
                      <ExternalLink size={10} />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {missing.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-2">
            Missing from ({missing.length})
          </h4>
          <ul className="flex flex-wrap gap-1.5">
            {missing.map((m) => (
              <li
                key={m.directory}
                className="text-[11px] font-mono text-zinc-400 px-2 py-0.5 rounded"
                style={{
                  background:
                    m.priority === 'high'
                      ? '#2a1505'
                      : m.priority === 'medium'
                        ? '#1a1303'
                        : '#0f0f0f',
                  color:
                    m.priority === 'high'
                      ? '#fb923c'
                      : m.priority === 'medium'
                        ? '#f5d56e'
                        : '#a1a1aa',
                }}
              >
                {m.directory}
              </li>
            ))}
          </ul>
        </div>
      )}

      {citations.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-2">
            Citations found ({citations.length})
          </h4>
          <ul className="space-y-1">
            {citations.map((c, idx) => (
              <li
                key={`${c.directory}-${idx}`}
                className="text-xs flex items-center gap-2 font-mono"
              >
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold flex-shrink-0"
                  style={{
                    background:
                      c.status === 'matched'
                        ? '#0a1f0d'
                        : c.status === 'mismatch'
                          ? '#2a1505'
                          : '#0f0f0f',
                    color:
                      c.status === 'matched'
                        ? '#a3e635'
                        : c.status === 'mismatch'
                          ? '#fb923c'
                          : '#a1a1aa',
                  }}
                >
                  {c.status}
                </span>
                <span className="text-zinc-400 flex-shrink-0">
                  {c.directory}
                </span>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-600 hover:text-zinc-300 truncate"
                  >
                    {c.url}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {citations.length === 0 &&
        inconsistencies.length === 0 &&
        missing.length === 0 && (
          <p className="text-xs text-zinc-500 italic">
            No findings recorded — possibly an empty directory set or all polls
            returned no profile data.
          </p>
        )}
    </div>
  );
}
