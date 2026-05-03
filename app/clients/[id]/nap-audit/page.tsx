/**
 * Operator-only NAP audit page — `/clients/[id]/nap-audit`.
 *
 * Server-renders the audit history (last 20 rows) and mounts the
 * NapAuditPanel client component which handles run + auto-poll +
 * findings-detail expansion. Not exposed in the client-facing portal.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import {
  NapAuditPanel,
  type NapAuditSummaryRow,
} from '@/components/turfmap/NapAuditPanel';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import type { ClientRow } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';

export default async function ClientNapAuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireAgencyUserOrRedirect(`/clients/${id}/nap-audit`);
  const supabase = getServerSupabase();

  const [{ data: client }, { data: audits }] = await Promise.all([
    supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .maybeSingle<ClientRow>(),
    supabase
      .from('nap_audits')
      .select(
        'id, status, created_at, completed_at, total_citations, inconsistencies_count, missing_high_priority_count, error_message'
      )
      .eq('client_id', id)
      .order('created_at', { ascending: false })
      .limit(20)
      .returns<NapAuditSummaryRow[]>(),
  ]);

  if (!client) notFound();

  const napFieldsComplete = Boolean(
    client.business_name &&
      client.phone &&
      client.street_address &&
      client.city &&
      client.region &&
      client.postcode
  );

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6 max-w-5xl">
        <Link
          href={`/clients/${client.id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to {client.business_name}
        </Link>
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold">NAP audit</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Cross-directory citation health check via BrightLocal Listings.
          </p>
        </div>

        <NapAuditPanel
          clientId={client.id}
          initialAudits={audits ?? []}
          napFieldsComplete={napFieldsComplete}
        />
      </div>
    </div>
  );
}
