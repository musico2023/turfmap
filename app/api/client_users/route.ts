/**
 * POST /api/client_users — add a portal user (email-only, no password).
 *
 * Side effect: ONLY whitelists the email. The portal sign-in flow is
 * magic-link, but Supabase's PKCE-based OTP can't be initiated from
 * the operator's session for delivery to a different recipient — the
 * code verifier ends up in the OPERATOR's cookies, so when the invitee
 * clicks the email link in their own browser they hit "PKCE code
 * verifier not found in storage". Instead, the recipient initiates
 * their own sign-in by visiting /portal/<public_id>/login and typing
 * their email; the existing /api/auth/magic-link path works because
 * the same browser owns the verifier.
 *
 * The settings UI exposes a "Copy sign-in link" button so the operator
 * can paste a stable URL into Slack/email/etc.; that's the v1 invite
 * UX. True auto-invite will return when Resend is wired (CLAUDE.md
 * Phase 3) — we'll generate a magic-link via admin.generateLink and
 * email it ourselves, sidestepping PKCE entirely.
 *
 * Body: { client_id, email }
 *
 * Constraints:
 *   - PORTAL_USERS_PER_CLIENT cap (currently 5). One brand rarely needs
 *     more than owner + ops + marketing.
 *   - client_users has a `unique(email)` constraint at the DB level
 *     (one email = one client account). Returns 409 with a friendly
 *     error on duplicate.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

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

  return NextResponse.json(data);
}
