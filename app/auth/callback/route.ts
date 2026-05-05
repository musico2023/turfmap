/**
 * GET /auth/callback
 *
 * Magic-link landing page. Two link formats land here:
 *
 *   1. PKCE flow (`?code=xxx`) — produced when a user requests their
 *      OWN magic link via signInWithOtp from their own browser. The
 *      verifier is in their cookies; we exchange the code for a
 *      session via exchangeCodeForSession.
 *
 *   2. OTP flow (`?token_hash=xxx&type=magiclink`) — produced when an
 *      operator-side flow (admin.generateLink) issues a link for a
 *      DIFFERENT recipient. No PKCE verifier needed; we exchange the
 *      token_hash for a session via verifyOtp. This is the path used
 *      by the portal-user invite email — see commits ae65cbc (the
 *      original PKCE breakage that motivated this) and the Resend
 *      auto-invite wiring that succeeds it.
 *
 * Either way: on success we stamp last_login_at on the matching
 * client_users row + redirect to `next`.
 */

import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const VALID_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set([
  'email',
  'magiclink',
  'recovery',
  'invite',
  'email_change',
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const otpTypeRaw = url.searchParams.get('type');

  // Default agency landing is `/clients` post-marketing-launch — `/` is
  // the public marketing surface now and would orphan a staff member
  // who completed their magic-link login. Portal flows always set an
  // explicit `next=/portal/<slug>` so they bypass this default.
  const nextRaw = url.searchParams.get('next') ?? '/clients';
  // Only allow same-origin redirects — protects against open-redirect
  // abuse via tampered `next` query params.
  const next = nextRaw.startsWith('/') ? nextRaw : '/clients';

  if (!code && !tokenHash) {
    return NextResponse.redirect(
      `${url.origin}${redirectWithError(next, 'missing code')}`
    );
  }

  const auth = await getAuthSupabase();

  let userEmail: string | null = null;
  if (code) {
    // PKCE flow — code + verifier in cookies → session.
    const { error, data } = await auth.auth.exchangeCodeForSession(code);
    if (error || !data.user) {
      return NextResponse.redirect(
        `${url.origin}${redirectWithError(next, error?.message ?? 'session exchange failed')}`
      );
    }
    userEmail = data.user.email ?? null;
  } else if (tokenHash) {
    // OTP flow — token_hash directly → session. No verifier needed.
    // Default to 'magiclink' if `type` is absent or unrecognized; the
    // portal-invite link embeds type=magiclink explicitly anyway.
    const otpType: EmailOtpType =
      otpTypeRaw && VALID_OTP_TYPES.has(otpTypeRaw as EmailOtpType)
        ? (otpTypeRaw as EmailOtpType)
        : 'magiclink';
    const { error, data } = await auth.auth.verifyOtp({
      type: otpType,
      token_hash: tokenHash,
    });
    if (error || !data.user) {
      return NextResponse.redirect(
        `${url.origin}${redirectWithError(next, error?.message ?? 'token verification failed')}`
      );
    }
    userEmail = data.user.email ?? null;
  }

  // Best-effort: stamp last_login_at on the matching client_users row.
  if (userEmail) {
    const admin = getServerSupabase();
    await admin
      .from('client_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('email', userEmail.toLowerCase());
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
  // headed after a successful retry. Skip the `next` query param when
  // it's already the default (`/clients`) — login form will fall back
  // to its own default and we keep the URL clean.
  const params = new URLSearchParams({ error: msg });
  if (next && next !== '/clients' && next !== '/') params.set('next', next);
  return `/login?${params.toString()}`;
}
