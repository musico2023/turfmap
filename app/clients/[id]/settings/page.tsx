/**
 * Client settings page — `/clients/[id]/settings`.
 *
 * Two cards stacked:
 *   1. ClientSettingsForm — edit business + branding + billing fields
 *   2. KeywordsManager    — list, add, and remove tracked keywords
 *
 * Both components are client-side and call the agency API routes
 * (`PATCH /api/clients/[id]`, `POST /api/keywords`, `DELETE /api/keywords/[id]`).
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import { ClientSettingsForm } from '@/components/turfmap/ClientSettingsForm';
import { KeywordsManager } from '@/components/turfmap/KeywordsManager';
import {
  ClientUsersManager,
  type ClientUserRow,
} from '@/components/turfmap/ClientUsersManager';
import { DeleteClientCard } from '@/components/turfmap/DeleteClientCard';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import type { ClientRow, TrackedKeywordRow } from '@/lib/supabase/types';

export default async function ClientSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await requireAgencyUserOrRedirect(`/clients/${id}/settings`);
  const supabase = getServerSupabase();

  const [{ data: client }, { data: keywords }, { data: portalUsers }] =
    await Promise.all([
      supabase
        .from('clients')
        .select('*')
        .eq('id', id)
        .maybeSingle<ClientRow>(),
      supabase
        .from('tracked_keywords')
        .select('*')
        .eq('client_id', id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .returns<TrackedKeywordRow[]>(),
      supabase
        .from('client_users')
        .select('id, client_id, email, invited_at, last_login_at')
        .eq('client_id', id)
        .order('invited_at', { ascending: false, nullsFirst: false })
        .returns<ClientUserRow[]>(),
    ]);

  if (!client) notFound();

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
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold">Settings</h1>
            <p className="text-xs text-zinc-500 mt-1">
              Edit client details, branding, and tracked keywords. Changes save
              individually per card.
            </p>
          </div>
          <Link
            href={`/portal/${client.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
          >
            Open white-label portal <ExternalLink size={11} />
          </Link>
        </div>

        <div className="space-y-6">
          <ClientSettingsForm client={client} />
          <KeywordsManager clientId={client.id} keywords={keywords ?? []} />
          <ClientUsersManager
            clientId={client.id}
            users={portalUsers ?? []}
          />
          <DeleteClientCard
            clientId={client.id}
            businessName={client.business_name}
          />
        </div>
      </div>
    </div>
  );
}
