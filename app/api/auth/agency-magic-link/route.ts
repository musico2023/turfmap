/**
 * POST /api/auth/agency-magic-link — send a magic-link to a TurfMap user
 * (an entry in the `users` table).
 *
 * Body: { email: string }
 *
 * Access model:
 *   - Fourdots-domain emails (lib/auth/agencyDomains) get auto-
 *     provisioned into `users` on first sign-in with role='admin'.
 *     Anyone Fourdots hires can request a link and immediately have
 *     full agency-level access to every client account; we do not
 *     maintain a per-staff allowlist.
 *   - Non-Fourdots emails must already exist in `users` (a paying
 *     TurfMap customer that the team has provisioned). Strangers get
 *     403 with a pointer to turfmap.ai.
 *
 * On success, Supabase emails the user; the redirect lands them at
 * /auth/callback?next=/clients (the agency console root). When the
 * caller passes an explicit `next` (e.g. for a deep-link sign-in
 * flow), that takes precedence.
 *
 * This is the agency-side counterpart to /api/auth/magic-link (which
 * targets per-client portal users — that endpoint has its own gate
 * via the client_users membership table).
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

  const admin = getServerSupabase();
  const { data: existing } = await admin
    .from('users')
    .select('id, email')
    .eq('email', email)
    .maybeSingle<{ id: string; email: string }>();

  if (!existing) {
    // First-time sign-in:
    //   - Fourdots-domain emails get auto-provisioned with role='admin'
    //     (anyone we hire gets agency access immediately).
    //   - Anyone else is told to sign up for TurfMap.
    if (!isAgencyDomainEmail(email)) {
      return NextResponse.json(
        {
          error:
            "this email isn't on the TurfMap account list. To get TurfMap access, sign up at turfmap.ai.",
        },
        { status: 403 }
      );
    }

    const { error: insertErr } = await admin
      .from('users')
      .insert({ email, role: 'admin' });
    if (insertErr) {
      // Race-condition tolerance: a unique-violation here means another
      // concurrent magic-link request beat us to the insert. The user
      // exists now, so fall through and send the OTP.
      const code = (insertErr as { code?: string }).code;
      if (code !== '23505') {
        return NextResponse.json(
          {
            error: `agency provisioning failed: ${insertErr.message}`,
          },
          { status: 500 }
        );
      }
    }
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
