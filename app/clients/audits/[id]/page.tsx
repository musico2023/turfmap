/**
 * Audit-delivery detail — `/clients/audits/[id]`.
 *
 * Per-order workspace for the strategist-managed deliverable. Layout:
 *
 *   ┌─ Header (business name, tier badge, paid date)
 *   ├─ Buyer info (email, phone, address)
 *   ├─ Auto-output links (portal dashboard, auto-PDF, NAP audit info)
 *   ├─ Strategist notes editor  ← client component (saves on demand)
 *   └─ Workflow actions ↑       ← Generate PDF / Mark Delivered
 *
 * Read-only states for already-delivered orders preserve the work
 * record but disable mutating actions.
 *
 * Auth: agency staff only. Buyers reach their portal via /portal/<slug>;
 * this page is exclusively the operator's workspace.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronLeft,
  Mail,
  Phone,
  MapPin,
  ExternalLink,
  Download,
} from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import { getServerSupabase } from '@/lib/supabase/server';
import { LinkButton } from '@/components/ui/Button';
import { AuditWorkflowPanel } from '@/components/turfmap/AuditWorkflowPanel';
import type {
  ClientRow,
  LeadOrderRow,
  ScanRow,
  Tier,
} from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';

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

export default async function AuditDeliveryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireAgencyUserOrRedirect(`/clients/audits/${id}`);
  const supabase = getServerSupabase();

  // Lookup the lead_orders row.
  const { data: order } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle<LeadOrderRow>();

  if (!order) notFound();

  // Reject non-audit-tier visits — TurfScan ($99) is fully self-serve,
  // Pulse / Pulse+ are subscriptions, none of those have human-touch
  // deliverables. Sending an operator here would be confusing.
  if (order.tier !== 'audit' && order.tier !== 'strategy') {
    return (
      <div className="min-h-screen w-full text-white">
        <Header userEmail={me.email} />
        <div className="px-8 py-12 max-w-2xl mx-auto">
          <h1 className="font-display text-xl font-bold mb-2">
            Not an audit-tier order
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            This order is on tier <code>{order.tier}</code>, which doesn&rsquo;t
            have a strategist-managed deliverable. The audit-deliveries
            queue only manages Visibility Audit ($499) and Strategy
            Session ($1,497) orders.
          </p>
          <Link
            href="/clients/audits"
            className="inline-flex items-center gap-1 mt-4 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ChevronLeft size={12} /> Back to audit deliveries
          </Link>
        </div>
      </div>
    );
  }

  // Fetch the buyer's clients row (always exists for fulfilled orders).
  const { data: client } = order.client_id
    ? await supabase
        .from('clients')
        .select('*')
        .eq('id', order.client_id)
        .maybeSingle<ClientRow>()
    : { data: null };

  // Most recent scan for this client (used for the auto-PDF link +
  // portal dashboard link).
  const { data: latestScan } = client
    ? await supabase
        .from('scans')
        .select('id, completed_at, status')
        .eq('client_id', client.id)
        .eq('status', 'complete')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle<Pick<ScanRow, 'id' | 'completed_at' | 'status'>>()
    : { data: null };

  const tierLabel = TIER_LABEL[order.tier];
  const tierPrice = TIER_PRICE[order.tier];
  const paidIso = new Date(order.created_at).toISOString().slice(0, 10);
  const deliveredIso = order.delivered_at
    ? new Date(order.delivered_at).toISOString().slice(0, 10)
    : null;

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6 max-w-4xl mx-auto">
        <Link
          href="/clients/audits"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to audit deliveries
        </Link>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
              {tierLabel} · {tierPrice} · paid {paidIso}
            </span>
            {deliveredIso && (
              <span
                className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded"
                style={{
                  background: '#1a2010',
                  color: 'var(--color-lime)',
                  border: '1px solid var(--color-border-bright)',
                }}
              >
                Delivered {deliveredIso}
              </span>
            )}
          </div>
          <h1 className="font-display text-2xl font-bold">
            {client?.business_name ?? 'Unknown buyer'}
          </h1>
        </div>

        {/* Buyer info + auto-output links — two-column on desktop */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div
            className="border rounded-lg p-5"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-3">
              Buyer
            </div>
            <ul className="space-y-2 text-sm">
              {order.email && (
                <li className="flex items-start gap-2 text-zinc-300">
                  <Mail
                    size={13}
                    className="text-zinc-500 mt-0.5 flex-shrink-0"
                  />
                  <a
                    href={`mailto:${order.email}`}
                    className="font-mono text-zinc-100 hover:text-white underline-offset-2 hover:underline truncate"
                  >
                    {order.email}
                  </a>
                </li>
              )}
              {client?.phone && (
                <li className="flex items-start gap-2 text-zinc-300">
                  <Phone
                    size={13}
                    className="text-zinc-500 mt-0.5 flex-shrink-0"
                  />
                  <span className="font-mono text-zinc-100">
                    {client.phone}
                  </span>
                </li>
              )}
              {client?.address && (
                <li className="flex items-start gap-2 text-zinc-300">
                  <MapPin
                    size={13}
                    className="text-zinc-500 mt-0.5 flex-shrink-0"
                  />
                  <span>{client.address}</span>
                </li>
              )}
            </ul>
          </div>

          <div
            className="border rounded-lg p-5"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-3">
              Auto-generated artifacts
            </div>
            <div className="space-y-2 text-sm">
              {client && (
                <Link
                  href={`/clients/${client.public_id}`}
                  className="flex items-center gap-2 text-zinc-300 hover:text-zinc-100 transition-colors"
                >
                  <ExternalLink size={13} className="text-zinc-500" />
                  <span>Open the buyer&rsquo;s scan dashboard</span>
                </Link>
              )}
              {latestScan && (
                <a
                  href={`/api/reports/pdf?scanId=${latestScan.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-zinc-300 hover:text-zinc-100 transition-colors"
                >
                  <Download size={13} className="text-zinc-500" />
                  <span>
                    Download auto-PDF (latest scan)
                  </span>
                </a>
              )}
              {!latestScan && (
                <p className="text-xs text-zinc-600 italic">
                  No completed scans yet for this client. Auto-PDF will
                  become available once the scan finishes.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* The strategist workflow panel — client component since it
         *  has interactive state (notes editor, action buttons). */}
        <AuditWorkflowPanel
          orderId={order.id}
          tier={order.tier}
          initialNotes={order.strategist_notes ?? ''}
          deliveryPdfUrl={order.delivery_pdf_url}
          deliveredAt={order.delivered_at}
          businessName={client?.business_name ?? null}
        />

        <div className="mt-6 text-[11px] text-zinc-600 font-mono leading-relaxed">
          Strategist workflow — Phase 1 (manual delivery). Phase 2 will
          add: call scheduling, GBP-screenshot upload (Strategy tier),
          Resend-based auto-email when the operator marks delivered.
        </div>
      </div>
    </div>
  );
}
