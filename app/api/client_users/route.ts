/**
 * POST /api/client_users — add a portal user (email-only, no password)
 * AND immediately email them a magic-link invite.
 *
 * The portal sign-in flow is magic-link. The naive implementation —
 * `signInWithOtp` from the operator's cookie-bound auth client — was
 * broken because Supabase's PKCE flow stored the code verifier in the
 * OPERATOR's cookies, so when the invitee clicked the link in their
 * own browser they hit "PKCE code verifier not found in storage" (see
 * commit ae65cbc).
 *
 * The current implementation sidesteps PKCE entirely:
 *   1. `admin.generateLink({ type: 'magiclink', email })` returns the
 *      raw token_hash without storing any per-browser state.
 *   2. We construct our own callback URL embedding `?token_hash=...`,
 *      pointing at /auth/callback (which now handles both PKCE `code=`
 *      and OTP `token_hash=` formats).
 *   3. Resend delivers the email ourselves with the
 *      sendPortalInvite template.
 *
 * Failure of the email send does NOT roll back the row — the
 * membership grant is the source of truth. The response carries
 * `invite_sent: true|false` so the UI can prompt the operator to
 * resend.
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
import { sendPortalInvite } from '@/lib/email/resend';
import type { ClientRow } from '@/lib/supabase/types';

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

  // Fire the magic-link invite via admin.generateLink + Resend.
  // Failure does NOT roll back the insert — see header comment.
  const inviteResult = await sendPortalInviteEmail({
    supabase,
    clientId: parsed.client_id,
    email,
    origin: req.headers.get('origin') ?? new URL(req.url).origin,
  });

  if (inviteResult.ok) {
    // Stamp invited_at so the UI shows "invited <date>" rather than
    // "not signed in yet".
    await supabase
      .from('client_users')
      .update({ invited_at: new Date().toISOString() })
      .eq('id', (data as { id: string }).id);
  }

  return NextResponse.json({
    ...data,
    invite_sent: inviteResult.ok,
    invite_error: inviteResult.ok ? null : inviteResult.error,
  });
}

/**
 * Generate a non-PKCE magic link via Supabase admin and email it to
 * the recipient via Resend. Returns ok:true on success, ok:false +
 * a redacted error string otherwise. Never throws.
 *
 * Exported indirectly by the POST handler; lives here rather than in
 * lib/ because it's tightly coupled to this endpoint's recovery /
 * resend semantics. If a second caller (e.g. a manual "resend"
 * endpoint) needs the same logic, lift it then.
 */
async function sendPortalInviteEmail(opts: {
  supabase: ReturnType<typeof getServerSupabase>;
  clientId: string;
  email: string;
  origin: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Pull the client's display fields so the email template has a real
  // business name + a clean public_id slug for the redirect URL.
  const { data: client } = await opts.supabase
    .from('clients')
    .select('business_name, public_id')
    .eq('id', opts.clientId)
    .maybeSingle<Pick<ClientRow, 'business_name' | 'public_id'>>();
  if (!client) {
    return { ok: false, error: 'client lookup failed' };
  }

  // Generate the magic link via the admin API. This does NOT store any
  // PKCE verifier — the link uses a token_hash that /auth/callback
  // exchanges via verifyOtp regardless of which browser opens it.
  // emailRedirectTo is a noise field for our flow (we build our own
  // URL below using `properties.hashed_token`) but the Supabase API
  // still requires it.
  const next = `/portal/${client.public_id}`;
  const callbackUrl = `${opts.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  let hashedToken: string | undefined;
  try {
    const { data: linkData, error: linkErr } =
      await opts.supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: opts.email,
        options: {
          redirectTo: callbackUrl,
        },
      });
    if (linkErr) {
      return { ok: false, error: linkErr.message };
    }
    hashedToken = linkData?.properties?.hashed_token;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (!hashedToken) {
    return { ok: false, error: 'admin.generateLink returned no hashed_token' };
  }

  // Build the link the recipient actually clicks — points at our own
  // /auth/callback so we control the verifyOtp + redirect, not
  // Supabase's hosted verifier. type=magiclink tells the callback
  // which OtpType to pass into verifyOtp.
  const params = new URLSearchParams({
    token_hash: hashedToken,
    type: 'magiclink',
    next,
  });
  const magicLinkUrl = `${opts.origin}/auth/callback?${params.toString()}`;

  const sent = await sendPortalInvite({
    to: opts.email,
    businessName: client.business_name,
    magicLinkUrl,
  });

  return sent
    ? { ok: true }
    : { ok: false, error: 'email send failed (see server logs)' };
}
