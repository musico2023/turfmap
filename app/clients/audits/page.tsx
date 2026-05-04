/**
 * Audit-deliveries queue — `/clients/audits`.
 *
 * Operator-facing surface for tracking the strategist-managed
 * Visibility Audit ($499) + Strategy Session ($1,497) orders. Lists
 * paid orders awaiting (or completed) human-touch deliverables.
 *
 * Lifecycle states (computed from lead_orders columns):
 *   - "Awaiting work"    : delivered_at IS NULL AND strategist_notes IS NULL
 *                          (paid, no notes yet)
 *   - "Notes drafted"    : strategist_notes IS NOT NULL AND
 *                          delivery_pdf_url IS NULL
 *   - "PDF generated"    : delivery_pdf_url IS NOT NULL AND
 *                          delivered_at IS NULL
 *   - "Delivered"        : delivered_at IS NOT NULL
 *
 * Ordering: in-progress orders first (oldest paid first → FIFO),
 * delivered orders below (most recently delivered first).
 *
 * No buyer ever sees this page. The detail page links to the read-
 * only buyer view at /portal/<public_id> when needed.
 */

import Link from 'next/link';
import { ChevronRight, Clock, CheckCircle2, FileText } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import { getServerSupabase } from '@/lib/supabase/server';
import type { LeadOrderRow, Tier } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';

type LeadOrderWithClient = LeadOrderRow & {
  clients:
    | {
        business_name: string;
        public_id: string;
        address: string | null;
      }
    | null;
};

const TIER_LABEL: Record<Tier, string> = {
  scan: 'TurfScan',
  audit: 'Visibility Audit',
  strategy: 'Strategy Session',
  pulse: 'Pulse',
  pulse_plus: 'Pulse+',
};

const TIER_PRICE: Record<Tier, string> = {
  scan: '$99',
  audit: '$499',
  strategy: '$1,497',
  pulse: '$39/mo',
  pulse_plus: '$89/mo',
};

type WorkflowState =
  | 'awaiting_work'
  | 'notes_drafted'
  | 'pdf_generated'
  | 'delivered';

function workflowState(o: LeadOrderRow): WorkflowState {
  if (o.delivered_at) return 'delivered';
  if (o.delivery_pdf_url) return 'pdf_generated';
  if (o.strategist_notes && o.strategist_notes.trim().length > 0) {
    return 'notes_drafted';
  }
  return 'awaiting_work';
}

const WORKFLOW_LABEL: Record<WorkflowState, string> = {
  awaiting_work: 'Awaiting work',
  notes_drafted: 'Notes drafted',
  pdf_generated: 'PDF generated',
  delivered: 'Delivered',
};

const WORKFLOW_TONE: Record<WorkflowState, { color: string; bg: string }> = {
  awaiting_work: { color: '#ff9f3a', bg: '#221a08' }, // amber — needs attention
  notes_drafted: { color: '#e8e54a', bg: '#1c1c0a' }, // yellow — partial
  pdf_generated: { color: '#a3e635', bg: '#1a1f0a' }, // light lime — almost done
  delivered: { color: 'var(--color-lime)', bg: '#1a2010' }, // lime — done
};

export default async function AuditQueuePage() {
  const me = await requireAgencyUserOrRedirect('/clients/audits');
  const supabase = getServerSupabase();

  // Fetch all paid audit-tier orders (Visibility Audit + Strategy
  // Session) with their joined client. PostgREST relational syntax via
  // the foreign-key relationship lead_orders.client_id → clients.id.
  const { data: orders } = await supabase
    .from('lead_orders')
    .select(
      `
      *,
      clients:client_id (
        business_name,
        public_id,
        address
      )
    `
    )
    .in('tier', ['audit', 'strategy'])
    .eq('status', 'fulfilled')
    .order('created_at', { ascending: true })
    .returns<LeadOrderWithClient[]>();

  const list = orders ?? [];

  // Split into in-progress (FIFO oldest first) and delivered (most
  // recent first). Two-segment list so the eye lands on what needs
  // doing, archived work below.
  const inProgress = list
    .filter((o) => o.delivered_at == null)
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  const delivered = list
    .filter((o) => o.delivered_at != null)
    .sort(
      (a, b) =>
        new Date(b.delivered_at!).getTime() -
        new Date(a.delivered_at!).getTime()
    );

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6 max-w-6xl mx-auto">
        <div className="mb-8">
          <Link
            href="/clients"
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
          >
            ← Back to agency clients
          </Link>
          <h1 className="font-display text-2xl font-bold">
            Audit deliveries
          </h1>
          <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed max-w-2xl">
            Strategist-managed delivery queue for{' '}
            <span className="text-zinc-300">Visibility Audit</span> and{' '}
            <span className="text-zinc-300">Strategy Session</span> orders.
            Each row is a paid order awaiting (or completed) human-touch
            deliverables: live call, strategist notes, customized PDF,
            buyer delivery.
          </p>
        </div>

        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="mb-10">
              <SectionHeader
                icon={<Clock size={14} />}
                label={`In progress (${inProgress.length})`}
                hint="Oldest paid first — FIFO. Don't let the queue back up."
              />
              {inProgress.length === 0 ? (
                <p className="text-xs text-zinc-600 italic">
                  Nothing in progress. Cleanup complete.
                </p>
              ) : (
                <div className="space-y-2">
                  {inProgress.map((o) => (
                    <OrderRow key={o.id} order={o} />
                  ))}
                </div>
              )}
            </div>

            {delivered.length > 0 && (
              <div>
                <SectionHeader
                  icon={<CheckCircle2 size={14} />}
                  label={`Delivered (${delivered.length})`}
                  hint="Audit log — most recent delivery first."
                />
                <div className="space-y-2 opacity-75">
                  {delivered.map((o) => (
                    <OrderRow key={o.id} order={o} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold flex items-center gap-1.5 mb-1">
        <span style={{ color: 'var(--color-lime)' }}>{icon}</span>
        {label}
      </div>
      {hint && (
        <p className="text-[11px] text-zinc-600 leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

function OrderRow({ order }: { order: LeadOrderWithClient }) {
  const state = workflowState(order);
  const tone = WORKFLOW_TONE[state];
  const tierLabel = TIER_LABEL[order.tier as Tier];
  const tierPrice = TIER_PRICE[order.tier as Tier];
  const businessName = order.clients?.business_name ?? '—';
  const businessAddress = order.clients?.address ?? '';
  const paidAgo = ageInDays(order.created_at);
  const deliveredAt = order.delivered_at
    ? new Date(order.delivered_at).toISOString().slice(0, 10)
    : null;

  return (
    <Link
      href={`/clients/audits/${order.id}`}
      className="block border rounded-lg px-5 py-4 transition-colors hover:border-zinc-700 group"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between gap-4">
        {/* Left: business + tier + state badge */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span
              className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded"
              style={{
                background: tone.bg,
                color: tone.color,
                border: `1px solid ${tone.color}40`,
              }}
            >
              {WORKFLOW_LABEL[state]}
            </span>
            <span className="text-[9px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
              {tierLabel} · {tierPrice}
            </span>
          </div>
          <div className="font-display text-base font-semibold text-zinc-100 truncate">
            {businessName}
          </div>
          {businessAddress && (
            <div className="text-xs text-zinc-500 truncate">
              {businessAddress}
            </div>
          )}
        </div>

        {/* Right: timing + chevron */}
        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
              {deliveredAt ? `Delivered ${deliveredAt}` : `Paid ${paidAgo}`}
            </div>
            {order.email && (
              <div className="text-[11px] text-zinc-600 font-mono truncate max-w-[200px]">
                {order.email}
              </div>
            )}
          </div>
          <ChevronRight
            size={16}
            className="text-zinc-600 group-hover:text-zinc-300 transition-colors"
          />
        </div>
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div
      className="border rounded-lg p-12 flex flex-col items-center text-center"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mb-5 border border-zinc-800"
        style={{ background: '#0a0a0a' }}
      >
        <FileText size={28} className="text-zinc-600" strokeWidth={1.5} />
      </div>
      <h4 className="font-display text-xl font-semibold text-zinc-300">
        No audit deliveries yet
      </h4>
      <p className="text-sm text-zinc-500 mt-2 max-w-md leading-relaxed">
        Visibility Audit ($499) and Strategy Session ($1,497) orders will
        appear here once buyers complete the order form on
        /order/success. Until Stripe products are configured + the first
        buyer comes through, this queue stays empty.
      </p>
    </div>
  );
}

function ageInDays(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}
