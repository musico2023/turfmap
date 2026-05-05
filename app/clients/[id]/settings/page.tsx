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
import { ChevronLeft, ExternalLink, UserPlus } from 'lucide-react';
import { Header } from '@/components/turfmap/Header';
import { InfoTooltip } from '@/components/turfmap/InfoTooltip';
import { ClientSettingsForm } from '@/components/turfmap/ClientSettingsForm';
import { KeywordsManager } from '@/components/turfmap/KeywordsManager';
import { LocationsManager } from '@/components/turfmap/LocationsManager';
import { LocationSwitcher } from '@/components/turfmap/LocationSwitcher';
import {
  CompetitorsManager,
  type TrackedCompetitorRow,
} from '@/components/turfmap/CompetitorsManager';
import {
  ClientUsersManager,
  type ClientUserRow,
} from '@/components/turfmap/ClientUsersManager';
import { DeleteClientCard } from '@/components/turfmap/DeleteClientCard';
import { SubscriptionPanel } from '@/components/turfmap/SubscriptionPanel';
import { AlertPrefsCard } from '@/components/turfmap/AlertPrefsCard';
import { ExportsCard } from '@/components/turfmap/ExportsCard';
import { getServerSupabase } from '@/lib/supabase/server';
import { listLocations, resolveLocation } from '@/lib/supabase/locations';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { buildKeywordSuggestions } from '@/lib/keywords/suggestions';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';
import { loadSubscriptionSummary } from '@/lib/stripe/subscription';
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

  // Tracked competitors for the active location. Empty = automatic
  // discovery on the dashboard; non-empty = curated mode.
  const { data: trackedCompetitors } = activeLocation
    ? await supabase
        .from('competitors')
        .select('id, competitor_name')
        .eq('client_id', id)
        .eq('location_id', activeLocation.id)
        .order('created_at', { ascending: true })
        .returns<TrackedCompetitorRow[]>()
    : { data: [] as TrackedCompetitorRow[] };

  // Self-serve subscription panel — only loads when the client is on
  // a recurring tier AND we have a Stripe subscription id on the row.
  // The summary lookup hits Stripe directly each render; that's fine
  // for this surface (settings page, low traffic) but if we ever
  // surface this on the dashboard we should mirror via the webhook
  // (item 2 in the roadmap) and read from the local row instead.
  const showSubscriptionPanel =
    client.billing_mode === 'self_serve_subscription' &&
    Boolean(client.stripe_subscription_id);
  const subscriptionSummary = showSubscriptionPanel
    ? await loadSubscriptionSummary(client.stripe_subscription_id as string)
    : null;

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
          <div className="flex items-center gap-4">
            <a
              href="#portal-users"
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
            >
              <UserPlus size={11} /> Add portal user
            </a>
            <span className="inline-flex items-center gap-1.5">
              <Link
                href={`/portal/${client.public_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
              >
                View client portal <ExternalLink size={11} />
              </Link>
              <InfoTooltip>
                Opens the customer-facing dashboard in a new tab —
                exactly what {client.business_name}&rsquo;s portal users
                see when they sign in. Useful for previewing the
                deliverable before sending invites or sharing the
                report URL with stakeholders.
              </InfoTooltip>
            </span>
          </div>
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
          <ClientSettingsForm
            client={client}
            primaryLocationId={
              locations.find((l) => l.is_primary)?.id ??
              locations[0]?.id ??
              null
            }
            pulsePlusActive={
              client.billing_mode === 'self_serve_subscription' ||
              client.billing_mode === 'agency_managed'
            }
          />
          <LocationsManager clientId={client.public_id} locations={locations} />
          <KeywordsManager
            clientId={client.id}
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
          <CompetitorsManager
            clientId={client.id}
            locationId={activeLocation?.id ?? null}
            locationLabel={
              activeLocation
                ? activeLocation.label || activeLocation.city || 'Primary'
                : null
            }
            competitors={trackedCompetitors ?? []}
          />
          <ClientUsersManager
            clientId={client.id}
            clientPublicId={client.public_id}
            users={portalUsers ?? []}
          />
          {/* AlertPrefsCard + ExportsCard render only on subscription
           *  / agency-managed clients — one_time clients (TurfScan /
           *  Audit / Strategy buyers) bought a one-shot product and
           *  don't have alert or recurring-export entitlements. The
           *  same showSubscriptionPanel gate covers both since both
           *  features are part of the recurring tier value prop. */}
          {showSubscriptionPanel && (
            <>
              <AlertPrefsCard
                clientId={client.id}
                initialPrefs={client.alert_prefs ?? null}
                initialSlackWebhookUrl={client.slack_webhook_url ?? null}
              />
              <ExportsCard
                clientId={client.id}
                clientPublicId={client.public_id}
                initialLookerToken={client.looker_token ?? null}
                appOrigin={
                  process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai'
                }
              />
            </>
          )}
          {showSubscriptionPanel && (
            <SubscriptionPanel
              clientId={client.id}
              summary={subscriptionSummary}
            />
          )}
          <DeleteClientCard
            clientId={client.public_id}
            businessName={client.business_name}
          />
        </div>
      </div>
    </div>
  );
}
