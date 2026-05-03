/**
 * White-label portal sign-in page — `/portal/[slug]/login`.
 *
 * Single-screen email form. POSTs to /api/auth/magic-link, which sends the
 * Supabase OTP and ultimately bounces back through /auth/callback into the
 * portal route.
 *
 * The agency's branding sits in the header (client logo + name + accent
 * color) so the prospect feels like they're signing into their own
 * service, not a generic SaaS auth page.
 */

import { notFound } from 'next/navigation';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { LoginForm } from './LoginForm';

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

  const accent = client.primary_color ?? '#c5ff3a';

  return (
    <div
      className="min-h-screen w-full text-white flex items-center justify-center px-6"
      style={{ ['--color-lime' as string]: accent } as React.CSSProperties}
    >
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
                boxShadow: `0 0 24px ${accent}40`,
                background: '#0a0a0a',
              }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center font-display font-bold text-black"
              style={{
                background: accent,
                boxShadow: `0 0 24px ${accent}40`,
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
