import { AlertTriangle, Crosshair, Plus } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow } from '@/lib/supabase/types';
import { Header } from '@/components/turfmap/Header';
import { SignOutButton } from '@/components/turfmap/SignOutButton';
import { ClientRoster } from '@/components/turfmap/ClientRoster';
import {
  StuckProspectsAlert,
  type StuckProspect,
} from '@/components/turfmap/StuckProspectsAlert';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';
import { LinkButton } from '@/components/ui/Button';

export default async function AgencyHomePage() {
  const me = await requireAgencyUserOrRedirect('/clients');

  // Domain gate — only agency-owner emails (fourdots.ca / fourdots.io)
  // see the cross-client roster. Non-owner agency staff (future
  // contractors, hypothetical hires from other domains) get a
  // friendly access-required screen instead. Defense in depth: the
  // logo / Agency-menu affordance in the Header is also hidden for
  // non-owner emails, so this page is generally only reached via
  // direct URL hit by someone outside the owner domain.
  if (!isAgencyOwnerEmail(me.email)) {
    return <NoOwnerAccessScreen email={me.email} />;
  }

  const supabase = getServerSupabase();
  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    // Hide outreach-enrichment rows — those back cold-lead share
    // links, not real billed clients, and would clutter this listing.
    .eq('is_outreach_lead', false)
    // Hide /score lead-magnet preview rows — they haven't paid yet.
    // Unlocking ($99) flips is_preview=false and the row appears here.
    .eq('is_preview', false)
    // Alphabetical by business name. Postgres's default ordering is
    // case-sensitive (capital letters first); we lowercase client-side
    // below to keep "Pizzeria" and "pizzeria" adjacent regardless.
    .order('business_name', { ascending: true });

  // Stuck-Stage-3 alert query — mirrors the cron's gate logic in
  // app/api/cron/cold-stage3/route.ts EXCEPT instead of requiring
  // email + first_name to be present (the cron's hard-skip condition),
  // we require at least ONE of them to be NULL. That's the operator
  // bucket: prospects who would otherwise get Stage 3 but can't
  // because their data is incomplete. Keep filters in sync with the
  // cron when those change.
  const { data: stuckRaw } = await supabase
    .from('prospects')
    .select(
      'id, business_name, trade, city, email, first_name, preview_score, scan_engaged_at'
    )
    .eq('cohort', 'cold_email_q2_2026')
    .not('converted_at', 'is', null)
    .not('scan_engaged_at', 'is', null)
    .is('stage_3_sent_at', null)
    .is('stage_3_disabled_at', null)
    .is('unsubscribed_at', null)
    .or('email.is.null,first_name.is.null')
    .order('scan_engaged_at', { ascending: false })
    .limit(50);
  const stuck = (stuckRaw ?? []) as StuckProspect[];

  const list = ((clients ?? []) as ClientRow[]).slice().sort((a, b) =>
    a.business_name.localeCompare(b.business_name, undefined, {
      sensitivity: 'base',
    })
  );

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold">Agency clients</h1>
            <p className="text-xs text-zinc-500 mt-1">
              {list.length} client{list.length === 1 ? '' : 's'} on TurfMap.
            </p>
          </div>
          <LinkButton
            variant="primary"
            size="md"
            href="/clients/new"
            leftIcon={<Plus size={14} strokeWidth={2.75} />}
          >
            Add client
          </LinkButton>
        </div>

        {/* Cold-cohort stuck-prospect alert — sits above the client
         *  roster so it's the first thing the agency owner sees on
         *  login when there's a Stage-3-blocked prospect that needs
         *  attention. Self-hides when stuck.length === 0. */}
        <StuckProspectsAlert stuck={stuck} />

        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <ClientRoster clients={list} />
        )}
      </div>
    </div>
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
        <Crosshair size={28} className="text-zinc-600" strokeWidth={1.5} />
      </div>
      <h4 className="font-display text-xl font-semibold text-zinc-300">
        No clients yet
      </h4>
      <p className="text-sm text-zinc-500 mt-2 max-w-sm">
        Run <span className="font-mono text-zinc-300">npm run test-scan</span>{' '}
        to seed a test client and its first scan.
      </p>
    </div>
  );
}

/**
 * Shown when an agency-staff user (in the `users` table) tries to
 * hit /clients but isn't on a fourdots-domain email. The cross-
 * client agency roster is owner-only; non-owner staff should be
 * working from individual client URLs they were granted access to.
 */
function NoOwnerAccessScreen({ email }: { email: string }) {
  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={email} />
      <div className="px-8 py-16 flex items-center justify-center">
        <div
          className="max-w-md w-full rounded-lg border p-8 text-center"
          style={{
            background: 'var(--color-card)',
            borderColor: '#3a1010',
          }}
        >
          <div
            className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
            style={{
              background: '#1a0a0a',
              border: '1px solid #3a1010',
            }}
          >
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <h3 className="font-display text-lg font-bold mb-2">
            Agency-owner access required
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed mb-5">
            Your account{' '}
            <span className="font-mono text-zinc-200">{email}</span> has
            staff access but isn&rsquo;t on the agency-owner domain.
            The cross-client roster is restricted; you can still open
            individual client URLs you were given.
          </p>
          <div className="flex justify-center">
            <SignOutButton size="md" />
          </div>
        </div>
      </div>
    </div>
  );
}
