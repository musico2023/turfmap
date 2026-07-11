/**
 * Pulse+ citation-build onboarding — `/clients/[id]/citations/setup`.
 *
 * Dedicated full-page form for the ~10 extra fields BrightLocal's
 * Citation Builder API needs beyond what the standard settings flow
 * collects. Linked from the Pulse+ welcome email and from the Citations
 * panel on the agency dashboard. Pre-fills NAP from the client's
 * primary location; the operator only fills in the citation-specific
 * fields (categories, description, hours, photos, website).
 *
 * On submit: POSTs to /api/citations/build, which inserts a
 * citation_orders row and fires the BL submit. On success, redirects
 * to the Citations panel where the operator can monitor per-directory
 * progress.
 */

import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { Header } from '@/components/turfmap/Header';
import { CitationOnboardingForm } from '@/components/turfmap/CitationOnboardingForm';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import {
  listLocations,
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import { LocationPickerNotice } from '@/components/turfmap/LocationPickerNotice';
import { requireAgencyUserOrRedirect } from '@/lib/auth/agency';

export default async function CitationSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ location?: string }>;
}) {
  const { id: clientParam } = await params;
  const { location: locationParam } = await searchParams;
  const me = await requireAgencyUserOrRedirect(
    `/clients/${clientParam}/citations/setup`
  );
  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) notFound();

  const locations = await listLocations(supabase, client.id);
  const activeLocation =
    (await resolveLocation(supabase, client.id, locationParam ?? null)) ??
    locations[0] ??
    null;

  if (!activeLocation) {
    return (
      <div className="min-h-screen w-full text-white">
        <Header userEmail={me.email} />
        <div className="px-8 py-6 max-w-3xl">
          <p className="text-sm text-zinc-400">
            This client has no locations yet. Add a location in settings
            before setting up citations.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />
      <div className="px-8 py-6 max-w-3xl">
        <Link
          href={`/clients/${client.public_id}`}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> Back to {client.business_name}
        </Link>
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold">Listings setup</h1>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl leading-relaxed">
            We need a few extra fields before we can distribute your
            business listings. Your NAP and address are pre-filled from
            settings — just add categories, hours, and a description. Major
            platforms (Google, Apple Maps, Bing, Facebook) sync within
            days; full propagation across 70+ directories takes 4–6 weeks.
          </p>
        </div>

        <LocationPickerNotice
          clientPublicId={client.public_id}
          activeLocation={{
            id: activeLocation.id,
            label: locationDisplayLabel(activeLocation),
            street_address: activeLocation.street_address,
            city: activeLocation.city,
            region: activeLocation.region,
          }}
          otherLocations={locations
            .filter((l) => l.id !== activeLocation.id)
            .map((l) => ({
              id: l.id,
              label: locationDisplayLabel(l),
            }))}
        />

        <CitationOnboardingForm
          clientId={client.id}
          clientPublicId={client.public_id}
          locationId={activeLocation.id}
          businessName={client.business_name}
          industry={client.industry}
          prefilledLocation={{
            street_address: activeLocation.street_address,
            city: activeLocation.city,
            region: activeLocation.region,
            postcode: activeLocation.postcode,
            country_code: activeLocation.country_code,
            phone: activeLocation.phone,
          }}
        />
      </div>
    </div>
  );
}
