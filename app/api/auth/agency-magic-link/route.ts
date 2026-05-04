/**
 * POST /api/auth/agency-magic-link — send a magic-link to an agency staff
 * member (someone in the `users` table).
 *
 * Body: { email: string }
 *
 * Two gates, both return 403:
 *   1. The email is on a Fourdots agency domain (lib/auth/agencyDomains).
 *      Sign-in to TurfMap is staff-only; clients use the per-portal
 *      magic link at /portal/<id>/login, and prospective customers
 *      need to subscribe (or buy a one-off) before getting access.
 *   2. The email is on the `users` table (defense in depth — covers
 *      the edge case of a Fourdots address that hasn't been provisioned
 *      as staff yet).
 *
 * On success, Supabase emails the user; the redirect lands them at
 * /auth/callback?next=/clients (the agency console root). When the
 * caller passes an explicit `next` (e.g. for a deep-link sign-in
 * flow), that takes precedence.
 *
 * This is the agency-side counterpart to /api/auth/magic-link (which
 * targets per-client portal users — that endpoint has its own gate
 * via the client_users membership table and intentionally has no
 * domain restriction).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';
import { isAgencyDomainEmail } from '@/lib/auth/agencyDomains';

export const runtime = 'nodejs';

const Body = z.object({
  email: z.string().email().max(320),
  /** Optional path the user should land on after signing in. */
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

  // Gate 1: Fourdots-domain check. TurfMap sign-in is staff-only.
  // Clients access their portal via /portal/<id>/login (different
  // endpoint, different membership table); prospective customers need
  // to subscribe before getting agency access.
  if (!isAgencyDomainEmail(email)) {
    return NextResponse.json(
      {
        error:
          "TurfMap sign-in is for Fourdots staff. If you're a Local Lead Machine client, your account manager will send your portal link. To get TurfMap access, subscribe at localleadmachine.io.",
      },
      { status: 403 }
    );
  }

  // Gate 2: users-table membership. Defense in depth — a Fourdots
  // address that hasn't been provisioned as staff still gets blocked.
  const admin = getServerSupabase();
  const { data: row } = await admin
    .from('users')
    .select('id, email')
    .eq('email', email)
    .maybeSingle<{ id: string; email: string }>();

  if (!row) {
    return NextResponse.json(
      {
        error:
          "this email isn't authorized for agency access — contact the team owner",
      },
      { status: 403 }
    );
  }

  const auth = await getAuthSupabase();
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  // Default landing is the agency console root (`/clients`) post-
  // marketing-launch — the bare `/` is now the public landing page,
  // so a magic link without an explicit next would otherwise drop
  // the staff member on the marketing surface they don't need.
  const next = parsed.next ?? '/clients';
  const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;

  const { error: otpErr } = await auth.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });

  if (otpErr) {
    return NextResponse.json(
      { error: `magic-link send failed: ${otpErr.message}` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
