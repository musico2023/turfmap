/**
 * POST /api/client_users — add a portal user (email-only, no password)
 * AND immediately send them a magic-link invite.
 *
 * The portal sign-in flow is magic-link — no password is set. Adding a
 * row to client_users grants this email permission to view the client
 * portal; the OTP send that follows means the new user gets an invite
 * in their inbox without the operator having to walk them through the
 * /portal/<id>/login form. Without that auto-invite, the operator
 * would add an email here and… nothing would happen — the user has to
 * separately discover the portal URL and request a link themselves.
 *
 * Body: { client_id, email }
 *
 * Constraints:
 *   - PORTAL_USERS_PER_CLIENT cap (currently 5). One brand rarely needs
 *     more than owner + ops + marketing; capping it here prevents
 *     abuse and keeps this from becoming a "share with your whole
 *     org" feature.
 *   - client_users has a `unique(email)` constraint at the DB level
 *     (one email = one client account). Trying to add the same email
 *     twice across clients returns 409 with a friendly error.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

/** Soft cap on portal users per client. Keeps this from sliding into
 *  "share with the whole org" territory and matches the realistic
 *  number of stakeholders on a small business team (owner + ops +
 *  marketing typically). Adjust here if it ever needs to grow. */
const PORTAL_USERS_PER_CLIENT = 5;

const Body = z.object({
  client_id: z.string().uuid(),
  email: z.string().email().max(320),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
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
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const email = parsed.email.trim().toLowerCase();

  // Cap check — count existing users for this client BEFORE inserting
  // so we don't have to roll back. Using head:true keeps it light.
  const { count: existingCount } = await supabase
    .from('client_users')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', parsed.client_id);
  if ((existingCount ?? 0) >= PORTAL_USERS_PER_CLIENT) {
    return NextResponse.json(
      {
        error: `portal-user cap reached (${PORTAL_USERS_PER_CLIENT} per client). Remove an existing user before adding another.`,
      },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('client_users')
    .insert({
      client_id: parsed.client_id,
      email,
    })
    .select('*')
    .single();

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json(
        { error: 'this email already belongs to a portal account' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `insert failed: ${error.message}` },
      { status: 500 }
    );
  }

  // Fire the magic-link invite. Done after the insert so the OTP
  // callback resolves to a member that already exists. Failure here
  // does NOT roll back the insert — the row is the source of truth
  // for "is this email allowed in the portal"; a transient email
  // delivery problem shouldn't undo the access grant. We surface
  // `invite_sent: false` so the UI can prompt the operator to resend.
  let inviteSent = true;
  let inviteError: string | null = null;
  try {
    const authClient = await getAuthSupabase();
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(
      `/portal/${parsed.client_id}`
    )}`;
    const { error: otpErr } = await authClient.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: true,
      },
    });
    if (otpErr) {
      inviteSent = false;
      inviteError = otpErr.message;
    } else {
      // Stamp invited_at so the UI shows "invited <date>" rather than
      // "never invited".
      await supabase
        .from('client_users')
        .update({ invited_at: new Date().toISOString() })
        .eq('id', (data as { id: string }).id);
    }
  } catch (e) {
    inviteSent = false;
    inviteError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    ...data,
    invite_sent: inviteSent,
    invite_error: inviteError,
  });
}
