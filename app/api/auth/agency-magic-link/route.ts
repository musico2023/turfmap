/**
 * POST /api/auth/agency-magic-link — unified sign-in entrypoint.
 *
 * Despite the historical name, this endpoint serves BOTH agency
 * staff (entries in `users`) and portal users (entries in
 * `client_users`). The /login page is the single sign-in surface for
 * the entire product; this endpoint figures out which kind of
 * account the email belongs to and routes the magic-link redirect
 * accordingly.
 *
 * Body: { email: string, next?: string }
 *
 * Resolution order:
 *   1. `users` row exists (agency staff) — magic link redirects to
 *      /clients (or `next` override).
 *   2. Email domain is a Fourdots-domain — auto-provisions a `users`
 *      row with role='admin', then magic link to /clients.
 *   3. `client_users` row exists (portal user with at least one
 *      client portal) — magic link redirects to /portal/<public_id>
 *      of the most recently invited / most recent portal access.
 *   4. None of the above — 403 with sign-up pointer.
 *
 * Email styling: uses lib/auth/sendMagicLink (admin.generateLink +
 * Resend SignInLinkEmail template), NOT signInWithOtp's unstyled
 * Supabase-default mailer. The template flavors copy by businessName
 * for portal users, agency-generic otherwise.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { isAgencyDomainEmail } from '@/lib/auth/agencyDomains';
import { sendMagicLink } from '@/lib/auth/sendMagicLink';
import { appOrigin } from '@/lib/urls';

export const runtime = 'nodejs';

const Body = z.object({
  email: z.string().email().max(320),
  next: z.string().startsWith('/').optional(),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const email = parsed.email.trim().toLowerCase();
  const admin = getServerSupabase();

  // ─── 1. Agency staff lookup ─────────────────────────────────────────
  const { data: agencyUser } = await admin
    .from('users')
    .select('id, email')
    .eq('email', email)
    .maybeSingle<{ id: string; email: string }>();

  let route: { kind: 'agency' } | { kind: 'portal'; clientPublicId: string; businessName: string } | null = null;

  if (agencyUser) {
    route = { kind: 'agency' };
  } else if (isAgencyDomainEmail(email)) {
    // ─── 2. Auto-provision Fourdots-domain emails as admin staff ──
    const { error: insertErr } = await admin
      .from('users')
      .insert({ email, role: 'admin' });
    if (insertErr) {
      const code = (insertErr as { code?: string }).code;
      if (code !== '23505') {
        // Race-condition tolerance: 23505 means a concurrent request
        // beat us; the row exists either way. Anything else is fatal.
        return NextResponse.json(
          { error: `agency provisioning failed: ${insertErr.message}` },
          { status: 500 }
        );
      }
    }
    route = { kind: 'agency' };
  } else {
    // ─── 3. Portal user lookup ────────────────────────────────────
    // Pick the most recent client_users row for this email (if any).
    // Portal users with access to multiple clients land on their
    // most recently invited one; they can navigate within the portal
    // afterwards.
    const { data: portalUser } = await admin
      .from('client_users')
      .select('id, client_id, invited_at, clients ( public_id, business_name )')
      .eq('email', email)
      .order('invited_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        client_id: string;
        invited_at: string | null;
        clients: { public_id: string; business_name: string } | null;
      }>();

    if (portalUser?.clients) {
      route = {
        kind: 'portal',
        clientPublicId: portalUser.clients.public_id,
        businessName: portalUser.clients.business_name,
      };
    }
  }

  // ─── 4. No matching account ─────────────────────────────────────────
  if (!route) {
    return NextResponse.json(
      {
        error:
          "We couldn't find an account for this email. If you're new to TurfMap, sign up at turfmap.ai. If you should have access, ask your agency to invite you.",
      },
      { status: 403 }
    );
  }

  const origin = appOrigin();
  const next =
    parsed.next ??
    (route.kind === 'agency'
      ? '/clients'
      : `/portal/${route.clientPublicId}`);

  const result = await sendMagicLink({
    supabase: admin,
    email,
    origin,
    next,
    businessName: route.kind === 'portal' ? route.businessName : null,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: `magic-link send failed: ${result.error}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
