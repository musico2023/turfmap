import { Activity, AlertTriangle, Check, Clock, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type {
  CitationDirectoryEntry,
  CitationOrderRow,
} from '@/lib/supabase/types';

/**
 * Pulse+ "Citations" panel rendered on the agency dashboard.
 *
 * Shows the live state of the active citation_orders row for the
 * client (one open order per location). When no order exists yet
 * (Pulse+ subscription is fresh + onboarding form not yet
 * submitted), the panel surfaces a CTA link to the setup form.
 *
 * For the render-side this is a server component that takes the
 * already-loaded order row + a handful of context props. The
 * dashboard page handles the data fetch.
 */

const STATUS_COPY: Record<
  CitationOrderRow['status'],
  { label: string; tone: 'pending' | 'progress' | 'success' | 'warn' | 'fail' }
> = {
  queued: { label: 'Queued', tone: 'pending' },
  in_progress: { label: 'Submitting', tone: 'progress' },
  complete: { label: 'All live', tone: 'success' },
  partial: { label: 'Needs attention', tone: 'warn' },
  failed: { label: 'Failed', tone: 'fail' },
};

const TONE_COLOR: Record<
  'pending' | 'progress' | 'success' | 'warn' | 'fail',
  string
> = {
  pending: '#a1a1aa',
  progress: '#e8e54a',
  success: 'var(--color-lime)',
  warn: '#ff9f3a',
  fail: '#ff4d4d',
};

const DIR_TONE: Record<CitationDirectoryEntry['status'], string> = {
  pending: '#71717a',
  submitted: '#e8e54a',
  live: 'var(--color-lime)',
  needs_review: '#ff9f3a',
  failed: '#ff4d4d',
};

const DIR_LABEL: Record<CitationDirectoryEntry['status'], string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  live: 'Live',
  needs_review: 'Needs review',
  failed: 'Failed',
};

export function CitationsPanel({
  order,
  clientPublicId,
}: {
  order: CitationOrderRow | null;
  clientPublicId: string;
}) {
  if (!order) {
    return <NoOrderCard clientPublicId={clientPublicId} />;
  }

  const dirs = order.per_directory ?? [];
  const liveCount = dirs.filter((d) => d.status === 'live').length;
  const needsReviewCount = dirs.filter((d) => d.status === 'needs_review').length;
  const submittedCount = dirs.filter((d) => d.status === 'submitted').length;
  const pendingCount = dirs.filter((d) => d.status === 'pending').length;
  const failedCount = dirs.filter((d) => d.status === 'failed').length;
  const total = dirs.length;
  const statusInfo = STATUS_COPY[order.status];

  return (
    <div
      id="citations"
      className="border rounded-lg p-5 scroll-mt-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-display text-lg font-bold">Citations</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {liveCount} of {total} citations live · {submittedCount + pendingCount}{' '}
            in flight
            {needsReviewCount > 0 && ` · ${needsReviewCount} need attention`}
          </p>
        </div>
        <span
          className="text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded font-mono whitespace-nowrap"
          style={{
            color: TONE_COLOR[statusInfo.tone],
            border: `1px solid ${TONE_COLOR[statusInfo.tone]}33`,
            background: `${TONE_COLOR[statusInfo.tone]}10`,
          }}
        >
          {statusInfo.label}
        </span>
      </div>

      {/* Progress bar — % live */}
      <div
        className="h-1.5 rounded-full overflow-hidden mb-5"
        style={{ background: 'var(--color-bg)' }}
      >
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{
            width: `${total === 0 ? 0 : Math.round((liveCount / total) * 100)}%`,
            background: 'var(--color-lime)',
            boxShadow: '0 0 8px #c5ff3a55',
          }}
        />
      </div>

      {/* Per-directory grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        {dirs.map((d) => (
          <DirRow key={d.directory} entry={d} />
        ))}
        {dirs.length === 0 && (
          <p className="text-xs text-zinc-600 italic">
            No directory submissions yet — order is still queueing at
            BrightLocal.
          </p>
        )}
      </div>

      {failedCount > 0 && order.error && (
        <div
          className="rounded-md border px-3 py-2 mb-3 text-xs"
          style={{
            background: 'rgba(255, 77, 77, 0.06)',
            borderColor: 'rgba(255, 77, 77, 0.3)',
            color: '#ff8b8b',
          }}
        >
          <strong className="font-semibold">Order error:</strong> {order.error}
        </div>
      )}

      <p className="text-[11px] text-zinc-600 leading-relaxed">
        First wave goes live within 2 weeks. Full propagation takes 6–8
        weeks. We&rsquo;ll keep these listings synced as long as your Pulse+
        subscription stays active.
      </p>
    </div>
  );
}

function DirRow({ entry }: { entry: CitationDirectoryEntry }) {
  const tone = DIR_TONE[entry.status];
  const Icon =
    entry.status === 'live'
      ? Check
      : entry.status === 'needs_review'
        ? AlertTriangle
        : entry.status === 'failed'
          ? AlertTriangle
          : entry.status === 'submitted'
            ? Activity
            : Clock;
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 rounded border text-xs"
      style={{
        background: 'var(--color-bg)',
        borderColor: 'var(--color-border)',
      }}
    >
      <Icon size={12} style={{ color: tone }} className="flex-shrink-0" />
      <span className="font-mono text-zinc-200 flex-1 truncate">
        {entry.directory}
      </span>
      {entry.url ? (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Open live listing"
        >
          <ExternalLink size={11} />
        </a>
      ) : null}
      <span
        className="text-[10px] font-mono uppercase tracking-wider whitespace-nowrap"
        style={{ color: tone }}
      >
        {DIR_LABEL[entry.status]}
      </span>
    </div>
  );
}

function NoOrderCard({ clientPublicId }: { clientPublicId: string }) {
  return (
    <div
      id="citations"
      className="border rounded-lg p-5 scroll-mt-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="font-display text-lg font-bold">Citations</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Pulse+ includes citation building across ~25 directories. Finish
            the citation profile to kick it off.
          </p>
        </div>
      </div>
      <Link
        href={`/clients/${clientPublicId}/citations/setup`}
        className="text-sm font-bold px-4 py-2 rounded inline-flex items-center gap-2 transition-all hover:brightness-110"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 4px 14px #c5ff3a30',
        }}
      >
        Set up citations →
      </Link>
    </div>
  );
}
