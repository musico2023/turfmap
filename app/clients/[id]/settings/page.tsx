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
import { LocationsManager } from '@/components/turfmap/LocationsManager';
import { LocationSwitcher } from '@/components/turfmap/LocationSwitcher';
import {
  ClientUsersManager,
  type ClientUserRow,
} from '@/components/turfmap/ClientUsersManager';
import { DeleteClientCard } from '@/components/turfmap/DeleteClientCard';
import { getServerSupabase } from '@/lib/supabase/server';
import { listLocations, resolveLocation } from '@/lib/supabase/locations';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { buildKeywordSuggestions } from '@/lib/keywords/suggestions';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import type { TrackedKeywordRow } from '@/lib/supabase/types';

export default async function ClientSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam } = await searchParams;
  const me = await requireAgencyUserOrRedirect(`/clients/${clientParam}/settings`);
  const supabase = getServerSupabase();

  // Tolerant lookup — public_id from new URLs or UUID from legacy bookmarks.
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) notFound();
  const id = client.id; // canonical UUID for FK queries

  const [{ data: portalUsers }, locations] = await Promise.all([
    supabase
      .from('client_users')
      .select('id, client_id, email, invited_at, last_login_at')
      .eq('client_id', id)
      .order('invited_at', { ascending: false, nullsFirst: false })
      .returns<ClientUserRow[]>(),
    listLocations(supabase, id),
  ]);

  // Resolve active location for the keyword card. The location switcher
  // surfaces above so the operator can swap.
  const activeLocation =
    (await resolveLocation(supabase, id, locationParam ?? null)) ??
    locations[0] ??
    null;
  const { data: keywords } = activeLocation
    ? await supabase
        .from('tracked_keywords')
        .select('*')
        .eq('client_id', id)
        .eq('location_id', activeLocation.id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
        .returns<TrackedKeywordRow[]>()
    : { data: [] as TrackedKeywordRow[] };

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6 max-w-5xl">
        <Link
          href={`/clients/${client.public_id}`}
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
            href={`/portal/${client.public_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
          >
            Open white-label portal <ExternalLink size={11} />
          </Link>
        </div>

        {locations.length > 1 && (
          <div className="mb-5">
            <LocationSwitcher
              clientId={client.public_id}
              locations={locations}
              activeLocationId={activeLocation?.id ?? null}
            />
          </div>
        )}

        <div className="space-y-6">
          <ClientSettingsForm client={client} />
          <LocationsManager clientId={client.public_id} locations={locations} />
          <KeywordsManager
            clientId={client.public_id}
            locationId={activeLocation?.id ?? null}
            locationLabel={
              activeLocation
                ? activeLocation.label || activeLocation.city || 'Primary'
                : null
            }
            suggestions={buildKeywordSuggestions(
              client.industry,
              activeLocation?.city ?? null
            )}
            keywords={keywords ?? []}
          />
          <ClientUsersManager
            clientId={client.public_id}
            users={portalUsers ?? []}
          />
          <DeleteClientCard
            clientId={client.public_id}
            businessName={client.business_name}
          />
        </div>
      </div>
    </div>
  );
}
