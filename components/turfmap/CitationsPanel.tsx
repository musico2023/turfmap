import { Activity, AlertTriangle, Check, Clock, ExternalLink, Globe } from 'lucide-react';
import Link from 'next/link';
import type {
  CitationDirectoryEntry,
  CitationOrderRow,
} from '@/lib/supabase/types';
import { PollCitationsNowButton } from '@/components/turfmap/PollCitationsNowButton';
import { MarkListingsActivatedButton } from '@/components/turfmap/MarkListingsActivatedButton';

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
  awaiting_confirm: { label: 'Verifying', tone: 'pending' },
  awaiting_activation: { label: 'Setting up', tone: 'pending' },
  active: { label: 'Syncing', tone: 'success' },
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
  locationId,
  locationLabel,
}: {
  order: CitationOrderRow | null;
  clientPublicId: string;
  locationId: string;
  locationLabel: string;
}) {
  if (!order) {
    return (
      <NoOrderCard
        clientPublicId={clientPublicId}
        locationId={locationId}
        locationLabel={locationLabel}
      />
    );
  }

  // GHL Listings orders (provider v2) have no per-directory status feed —
  // the network syncs continuously. Render the sync-state card instead of
  // the BL submission grid.
  if (order.provider === 'ghl_listings') {
    return <GhlListingsCard order={order} />;
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
        <div className="flex items-center gap-2">
          <PollCitationsNowButton orderId={order.id} />
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
            No directory submissions yet — order is still queueing.
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

/**
 * GHL Listings (Uberall engine) order card. Two states:
 *   awaiting_activation → operator hasn't flipped Listings ON in the GHL
 *                         dashboard yet; show the Mark-activated button
 *   active              → sync is running; show the always-on promise
 */
function GhlListingsCard({ order }: { order: CitationOrderRow }) {
  const statusInfo = STATUS_COPY[order.status] ?? STATUS_COPY.failed;
  const awaiting = order.status === 'awaiting_activation';
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
            {awaiting
              ? 'Profile received — listings sync is being set up.'
              : 'Business profile syncing across 70+ directories.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {awaiting && <MarkListingsActivatedButton orderId={order.id} />}
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
      </div>

      <div
        className="flex items-center gap-3 px-4 py-3 rounded border text-sm mb-4"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <Globe
          size={16}
          className="flex-shrink-0"
          style={{
            color: awaiting ? '#a1a1aa' : 'var(--color-lime)',
          }}
        />
        <div className="text-xs text-zinc-400 leading-relaxed">
          {awaiting ? (
            <>
              Your business details (name, address, hours, categories,
              description) are queued for distribution. Syncing typically
              starts within 1 business day — this panel flips to{' '}
              <span className="text-zinc-200 font-semibold">Syncing</span>{' '}
              automatically.
            </>
          ) : (
            <>
              Name, address, phone, hours, categories and description are
              kept consistent across Google, Apple Maps, Bing, Facebook and
              70+ other directories — updates propagate automatically while
              your subscription is active.
            </>
          )}
        </div>
      </div>

      {order.error && (
        <div
          className="rounded-md border px-3 py-2 mb-3 text-xs"
          style={{
            background: 'rgba(255, 159, 58, 0.06)',
            borderColor: 'rgba(255, 159, 58, 0.3)',
            color: '#ffcf99',
          }}
        >
          <strong className="font-semibold">Setup note:</strong> {order.error}
        </div>
      )}

      <p className="text-[11px] text-zinc-600 leading-relaxed">
        Listings stay synced for as long as your Pulse+ subscription is
        active. Data corrections land on all directories from a single
        update — no per-site logins needed.
      </p>
    </div>
  );
}

function NoOrderCard({
  clientPublicId,
  locationId,
  locationLabel,
}: {
  clientPublicId: string;
  locationId: string;
  locationLabel: string;
}) {
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
            the citation profile for{' '}
            <span className="text-zinc-300">{locationLabel}</span> to kick
            it off.
          </p>
        </div>
      </div>
      <Link
        href={`/clients/${clientPublicId}/citations/setup?location=${locationId}`}
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
