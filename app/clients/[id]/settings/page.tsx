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
import { InfoTooltip } from '@/components/turfmap/InfoTooltip';
import { ClientSettingsForm } from '@/components/turfmap/ClientSettingsForm';
import { BootstrapAuditCard } from '@/components/turfmap/BootstrapAuditCard';
import { KeywordsManager } from '@/components/turfmap/KeywordsManager';
import { LocationsManager } from '@/components/turfmap/LocationsManager';
import { LocationSwitcher } from '@/components/turfmap/LocationSwitcher';
import {
  SettingsTabs,
  isSettingsTabId,
  type SettingsTabId,
} from '@/components/turfmap/SettingsTabs';
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
import { TierOverrideCard } from '@/components/turfmap/TierOverrideCard';
import { ConvertToManagedCard } from '@/components/turfmap/ConvertToManagedCard';
import { ConvertToSelfServeCard } from '@/components/turfmap/ConvertToSelfServeCard';
import { AwaitingPaymentSetupCard } from '@/components/turfmap/AwaitingPaymentSetupCard';
import { AlertPrefsCard } from '@/components/turfmap/AlertPrefsCard';
import { ExportsCard } from '@/components/turfmap/ExportsCard';
import { canAccessExports, resolveTier } from '@/lib/subscription/tier';
import { getServerSupabase } from '@/lib/supabase/server';
import { listLocations, resolveLocation } from '@/lib/supabase/locations';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { buildKeywordSuggestions } from '@/lib/keywords/suggestions';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';
import { loadSubscriptionSummary } from '@/lib/stripe/subscription';
import type { TrackedKeywordRow } from '@/lib/supabase/types';

export default async function ClientSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string; tab?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam, tab: tabParam } = await searchParams;
  const activeTab: SettingsTabId = isSettingsTabId(tabParam) ? tabParam : 'general';
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

  // Tier-driven gating for Pulse+-only cards on the settings page.
  // Recurring-tier clients see the tier override card; Pulse+ unlocks
  // the alert-prefs + exports surfaces.
  const tierForGating = resolveTier(client);
  const isRecurring = client.billing_mode !== 'one_time';
  const showExports = canAccessExports(tierForGating);

  // BootstrapAuditCard prep — agency-owner-only card on the General
  // tab. Fetch the most recent visibility_audits row (if any) so the
  // card can render in "Regenerate" mode + surface the current PDF
  // URL. Also pull the freshest lead_order.email as a default for the
  // operator's "buyer email" field. Both lookups soft-fail to null —
  // the card handles missing data fine.
  const showBootstrapAuditCard = isAgencyOwnerEmail(me.email);
  let bootstrapExistingAudit: {
    id: string;
    roadmapPdfUrl: string | null;
    strategistCallScheduledAt: string | null;
  } | null = null;
  let bootstrapDefaultEmail: string | null = null;
  if (showBootstrapAuditCard) {
    const { data: latestAudit } = await supabase
      .from('visibility_audits')
      .select('id, roadmap_pdf_url, strategist_call_scheduled_at')
      .eq('client_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        roadmap_pdf_url: string | null;
        strategist_call_scheduled_at: string | null;
      }>();
    if (latestAudit) {
      bootstrapExistingAudit = {
        id: latestAudit.id,
        roadmapPdfUrl: latestAudit.roadmap_pdf_url,
        strategistCallScheduledAt: latestAudit.strategist_call_scheduled_at,
      };
    }
    const { data: latestOrder } = await supabase
      .from('lead_orders')
      .select('email')
      .eq('client_id', id)
      .not('email', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ email: string }>();
    bootstrapDefaultEmail = latestOrder?.email ?? null;
  }

  // "Awaiting buyer payment setup" — the client was created via the
  // agency-side plan selector with a Stripe plan, but the buyer
  // hasn't yet completed Checkout (so stripe_subscription_id is
  // still null). Banner surfaces above the regular cards until the
  // webhook activates the row.
  const awaitingPaymentSetup =
    client.billing_mode === 'self_serve_subscription' &&
    !client.stripe_subscription_id;

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

        {/* Awaiting-payment-setup banner is page-global — every tab
         *  benefits from seeing it until the buyer completes Checkout. */}
        {awaitingPaymentSetup && (
          <div className="mb-6">
            <AwaitingPaymentSetupCard
              clientId={client.id}
              tier={client.tier}
              pendingBuyerEmail={client.pending_buyer_email}
            />
          </div>
        )}

        <SettingsTabs
          basePath={`/clients/${client.public_id}/settings`}
          active={activeTab}
          locationId={activeLocation?.id ?? null}
        />

        {/* ─── General: client-level config (NOT location-scoped) ──── */}
        {activeTab === 'general' && (
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
            <LocationsManager
              clientId={client.public_id}
              locations={locations}
              tier={tierForGating}
              selfServeBilling={
                client.billing_mode === 'self_serve_subscription' &&
                Boolean(client.stripe_subscription_id)
              }
            />
            {/* Operator-only — agency-owner-domain emails. Wraps the
             *  /api/admin/bootstrap-comp-audit endpoint in a UI so a
             *  Visibility Audit deliverable can be generated without
             *  dropping into a terminal. */}
            {showBootstrapAuditCard && (
              <BootstrapAuditCard
                clientId={client.id}
                clientPublicId={client.public_id}
                defaultEmail={bootstrapDefaultEmail}
                existingAudit={bootstrapExistingAudit}
              />
            )}
          </div>
        )}

        {/* ─── Tracking: per-location keywords + competitors ────────
         *  The location switcher is the explicit divider — everything
         *  below it is scoped to the active location. */}
        {activeTab === 'tracking' && (
          <div className="space-y-6">
            {locations.length > 1 && (
              <LocationSwitcher
                clientId={client.public_id}
                locations={locations}
                activeLocationId={activeLocation?.id ?? null}
              />
            )}
            {locations.length <= 1 && (
              <p className="text-xs text-zinc-500 -mt-2">
                Keywords and competitors are scoped per-location. Add a
                second location in the General tab to surface the
                location switcher here.
              </p>
            )}
            <KeywordsManager
              clientId={client.id}
              locationId={activeLocation?.id ?? null}
              locationLabel={
                activeLocation
                  ? activeLocation.label || activeLocation.city || 'Primary'
                  : null
              }
              tier={tierForGating}
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
          </div>
        )}

        {/* ─── Plan & Access: billing + tier + alerts + exports + portal users + convert ─── */}
        {activeTab === 'plan' && (
          <div className="space-y-6">
            {showSubscriptionPanel && (
              <SubscriptionPanel
                clientId={client.id}
                summary={subscriptionSummary}
              />
            )}
            {/* Tier override — recurring clients only. */}
            {isRecurring && (
              <TierOverrideCard
                clientId={client.public_id}
                initialTier={client.tier}
              />
            )}
            {/* AlertPrefsCard — recurring tiers only; granular toggles
             *  unlock for Pulse+ inside the card itself. */}
            {isRecurring && (
              <AlertPrefsCard
                clientId={client.id}
                clientPublicId={client.public_id}
                tier={tierForGating}
                initialPrefs={client.alert_prefs ?? null}
                slackTeamName={client.slack_team_name ?? null}
                slackChannelName={client.slack_channel_name ?? null}
                slackConnected={Boolean(client.slack_webhook_url)}
              />
            )}
            {/* ExportsCard — Pulse+ only. */}
            {showExports && (
              <ExportsCard
                clientId={client.id}
                clientPublicId={client.public_id}
                initialLookerToken={client.looker_token ?? null}
                appOrigin={
                  process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai'
                }
              />
            )}
            <ClientUsersManager
              clientId={client.id}
              clientPublicId={client.public_id}
              users={portalUsers ?? []}
            />
            {/* Convert self-serve → agency-managed. Domain-gated to
             *  agency-owner emails on top of the agency-staff check. */}
            {showSubscriptionPanel && isAgencyOwnerEmail(me.email) && (
              <ConvertToManagedCard
                clientId={client.id}
                currentTier={client.tier}
              />
            )}
            {/* Mirror — agency-managed → self-serve. Same gate. */}
            {client.billing_mode === 'agency_managed' &&
              isAgencyOwnerEmail(me.email) && (
                <ConvertToSelfServeCard
                  clientId={client.id}
                  currentTier={client.tier}
                />
              )}
          </div>
        )}

        {/* ─── Danger zone: irreversible actions only ─────────────── */}
        {activeTab === 'danger' && (
          <div className="space-y-6">
            <DeleteClientCard
              clientId={client.public_id}
              businessName={client.business_name}
            />
          </div>
        )}
      </div>
    </div>
  );
}
