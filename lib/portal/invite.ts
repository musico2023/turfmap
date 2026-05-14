/**
 * Portal-invite helper — generates a magic link via Supabase admin
 * + ships it through Resend's PortalInvite template.
 *
 * Called from:
 *   - /api/client_users (agency-side invite flow)
 *   - /api/onboarding/[publicId] (buyer wizard "invite teammates" step)
 *
 * Failures are swallowed into a typed result; callers decide whether
 * to roll back the underlying client_users row insert.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPortalInvite } from '@/lib/email/resend';
import type { ClientRow } from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type PortalInviteResult = { ok: true } | { ok: false; error: string };

export async function sendPortalInviteEmail(opts: {
  supabase: SupabaseLike;
  clientId: string;
  email: string;
  origin: string;
}): Promise<PortalInviteResult> {
  const { data: client } = await opts.supabase
    .from('clients')
    .select('business_name, public_id')
    .eq('id', opts.clientId)
    .maybeSingle<Pick<ClientRow, 'business_name' | 'public_id'>>();
  if (!client) {
    return { ok: false, error: 'client lookup failed' };
  }

  const next = `/portal/${client.public_id}`;
  const callbackUrl = `${opts.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  let hashedToken: string | undefined;
  try {
    const { data: linkData, error: linkErr } =
      await opts.supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: opts.email,
        options: { redirectTo: callbackUrl },
      });
    if (linkErr) return { ok: false, error: linkErr.message };
    hashedToken = linkData?.properties?.hashed_token;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!hashedToken) {
    return { ok: false, error: 'admin.generateLink returned no hashed_token' };
  }

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
