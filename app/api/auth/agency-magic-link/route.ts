/**
 * POST /api/auth/agency-magic-link — send a magic-link to an agency staff
 * member (someone in the `users` table).
 *
 * Body: { email: string }
 *
 * Pre-checks the email is on the staff list (so a stranger probing the
 * endpoint gets 403 instead of a real signup). On success, Supabase emails
 * the user; the redirect lands them at /auth/callback?next=/, which
 * forwards them to the agency dashboard.
 *
 * This is the agency-side counterpart to /api/auth/magic-link (which
 * targets per-client portal users).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';

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

  const admin = getServerSupabase();
  const email = parsed.email.trim().toLowerCase();
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
  const next = parsed.next ?? '/';
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
