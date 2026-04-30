/**
 * GET /auth/callback?code=...&next=/portal/<id>
 *
 * Magic-link landing page. Supabase has already issued the user a
 * one-time `code`; we exchange it for a session cookie and forward the
 * user to their `next` URL (the portal they originally requested) on
 * success, or back to the login page with an error on failure.
 */

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const nextRaw = url.searchParams.get('next') ?? '/';
  // Only allow same-origin redirects — protects against open-redirect abuse.
  const next = nextRaw.startsWith('/') ? nextRaw : '/';

  if (!code) {
    return NextResponse.redirect(
      `${url.origin}${redirectWithError(next, 'missing code')}`
    );
  }

  const auth = await getAuthSupabase();
  const { error, data } = await auth.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(
      `${url.origin}${redirectWithError(next, error?.message ?? 'session exchange failed')}`
    );
  }

  // Best-effort: stamp last_login_at on the matching client_users row.
  if (data.user.email) {
    const admin = getServerSupabase();
    await admin
      .from('client_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('email', data.user.email.toLowerCase());
  }

  return NextResponse.redirect(`${url.origin}${next}`);
}

function redirectWithError(next: string, msg: string): string {
  // Bounce back to whichever login surface the user was originally trying
  // to reach, surfacing the error on the form so they can retry.
  if (next.startsWith('/portal/')) {
    const slug = next.split('/')[2];
    return `/portal/${slug}/login?error=${encodeURIComponent(msg)}`;
  }
  // Agency-side default — preserve `next` so they land where they were
  // headed after a successful retry.
  const params = new URLSearchParams({ error: msg });
  if (next && next !== '/') params.set('next', next);
  return `/login?${params.toString()}`;
}
