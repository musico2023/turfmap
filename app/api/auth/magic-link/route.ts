/**
 * POST /api/auth/magic-link — send a Supabase magic-link to a client portal user.
 *
 * Body: { client_id: uuid, email: string }
 *
 * Pre-checks the email is on the `client_users` table for the given client
 * (using the service-role client). If it isn't, we return 403 instead of
 * sending a link — saves the user from clicking a link that would just
 * dump them at the access-denied screen.
 *
 * On success, Supabase emails the user a one-time-token URL. The redirect
 * sends them to /auth/callback?next=/portal/<client_id>, which exchanges
 * the token and forwards them to their portal.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
  email: z.string().email().max(320),
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

  // Service-role check: is this email on the membership list for this client?
  const admin = getServerSupabase();
  const email = parsed.email.trim().toLowerCase();
  const { data: row } = await admin
    .from('client_users')
    .select('id, email, client_id')
    .eq('client_id', parsed.client_id)
    .eq('email', email)
    .maybeSingle<{ id: string; email: string; client_id: string }>();

  if (!row) {
    return NextResponse.json(
      {
        error:
          'this email is not authorized to view this client portal — contact your account manager',
      },
      { status: 403 }
    );
  }

  // Send the magic link. The user-context client (anon key) is required
  // here so cookies on the eventual callback bind to the same Supabase
  // project. We pass `next=/portal/<id>` through the redirect URL.
  const auth = await getAuthSupabase();
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(`/portal/${parsed.client_id}`)}`;

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

  // Stamp last_login_at on the next successful callback exchange — for now
  // we mark "invited" timestamp so the agency can tell who's been emailed.
  await admin
    .from('client_users')
    .update({ invited_at: new Date().toISOString() })
    .eq('id', row.id);

  return NextResponse.json({ ok: true });
}
