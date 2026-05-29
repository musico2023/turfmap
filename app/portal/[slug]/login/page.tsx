/**
 * White-label portal sign-in page — `/portal/[slug]/login`.
 *
 * Single-screen email form. POSTs to /api/auth/magic-link, which sends the
 * Supabase OTP and ultimately bounces back through /auth/callback into the
 * portal route.
 *
 * The agency's branding sits in the header (client logo + name) so the
 * prospect feels like they're signing into their own service, not a
 * generic SaaS auth page. Brand-accent customization was removed —
 * every portal renders with TurfMap's standard lime + dark surfaces,
 * with only the logo varying per client.
 */

import { notFound, redirect } from 'next/navigation';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { LoginForm } from './LoginForm';
import type { ScanRow, ScanShareLinkRow } from '@/lib/supabase/types';

export default async function PortalLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error } = await searchParams;
  const supabase = getServerSupabase();
  // Tolerant lookup — supports both legacy UUID URLs and the new
  // public_id slugs introduced in migration 0007.
  const client = await findClientByPublicIdOrUuid(supabase, slug);
  if (!client) notFound();

  // ─── Outreach-lead redirect ─────────────────────────────────────────
  // Cold-outreach prospects (is_outreach_lead=true) shouldn't see the
  // agency-client portal login UNLESS they've been provisioned portal
  // access (a client_users row exists). Once an outreach lead
  // converts to a paying audit buyer, audit initialization auto-
  // provisions client_users so they can magic-link in normally. The
  // redirect-to-share path stays for outreach leads who never
  // converted (no portal access → show share or expired-link
  // message rather than the auth-rejection screen).
  if (client.is_outreach_lead) {
    const { count: portalMemberCount } = await supabase
      .from('client_users')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id);
    if (!portalMemberCount || portalMemberCount === 0) {
      const { data: scan } = await supabase
        .from('scans')
        .select('id')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<Pick<ScanRow, 'id'>>();
      if (scan) {
        const { data: share } = await supabase
          .from('scan_share_links')
          .select('id, expires_at, revoked_at')
          .eq('scan_id', scan.id)
          .is('revoked_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<
            Pick<ScanShareLinkRow, 'id' | 'expires_at' | 'revoked_at'>
          >();
        if (share && new Date(share.expires_at).getTime() >= Date.now()) {
          redirect(`/share/${share.id}`);
        }
      }
      // No active share link found — render a clearer expired-link
      // message instead of the agency-portal rejection.
      return (
      <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
        <div
          className="w-full max-w-md rounded-lg border p-8 text-center"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="font-display text-xl font-bold mb-3">
            This scan link has expired.
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed mb-4">
            We sent {client.business_name} a TurfMap scan, but the
            share link is no longer active. Email{' '}
            <a
              href="mailto:hello@turfmap.ai"
              className="text-zinc-200 underline"
            >
              hello@turfmap.ai
            </a>{' '}
            and we&apos;ll send you a fresh one.
          </p>
          <div
            className="mt-8 pt-5 border-t text-[10px] text-zinc-600 leading-relaxed"
            style={{ borderColor: 'var(--color-border)' }}
          >
            Powered by{' '}
            <span className="text-zinc-400 font-semibold">TurfMap™</span>.
          </div>
        </div>
      </div>
    );
    }
    // Has portal members → fall through to the normal login form
    // (lets audit-buyer outreach leads sign in normally).
  }

  return (
    <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
      <div
        className="w-full max-w-md rounded-lg border p-8"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center gap-3 mb-6">
          {client.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={client.logo_url}
              alt={client.business_name}
              className="w-9 h-9 rounded-md object-contain p-0.5"
              style={{
                boxShadow: '0 0 24px #c5ff3a40',
                background: '#0a0a0a',
              }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center font-display font-bold text-black"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 24px #c5ff3a40',
              }}
            >
              {client.business_name.trim().charAt(0).toUpperCase() || 'T'}
            </div>
          )}
          <div>
            <div className="font-display text-lg font-bold leading-tight">
              {client.business_name}
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
              Local visibility report · sign in
            </div>
          </div>
        </div>

        <LoginForm clientId={client.id} initialError={error ?? null} />

        <div className="mt-8 pt-5 border-t text-[10px] text-zinc-600 leading-relaxed" style={{ borderColor: 'var(--color-border)' }}>
          Powered by <span className="text-zinc-400 font-semibold">TurfMap™</span>. Access is granted by your account manager.
        </div>
      </div>
    </div>
  );
}
