/**
 * Issue a magic-link via Supabase admin and ship it through Resend
 * with our branded SignInLinkEmail template.
 *
 * Why not signInWithOtp: Supabase's built-in mailer uses an unstyled
 * default template that doesn't match the rest of TurfMap's email
 * brand. admin.generateLink returns a token_hash we can wrap in our
 * own /auth/callback URL and ship via Resend with full template
 * control.
 *
 * Same auth-callback flow either way — token_hash + type=magiclink
 * are exchanged via verifyOtp on the callback handler. This means
 * sign-in links work cross-browser (no PKCE verifier required).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSignInLink } from '@/lib/email/resend';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type MagicLinkResult = { ok: true } | { ok: false; error: string };

export async function sendMagicLink(opts: {
  supabase: SupabaseLike;
  email: string;
  origin: string;
  /** Path the user lands on after callback exchanges the token. */
  next: string;
  /** Set for portal sign-ins to flavor the email copy. Null/undefined
   *  for agency sign-ins. */
  businessName?: string | null;
}): Promise<MagicLinkResult> {
  let hashedToken: string | undefined;
  try {
    const { data, error } = await opts.supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: opts.email,
      options: { redirectTo: `${opts.origin}/auth/callback?next=${encodeURIComponent(opts.next)}` },
    });
    if (error) return { ok: false, error: error.message };
    hashedToken = data?.properties?.hashed_token;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!hashedToken) {
    return { ok: false, error: 'admin.generateLink returned no hashed_token' };
  }

  const params = new URLSearchParams({
    token_hash: hashedToken,
    type: 'magiclink',
    next: opts.next,
  });
  const magicLinkUrl = `${opts.origin}/auth/callback?${params.toString()}`;

  const sent = await sendSignInLink({
    to: opts.email,
    magicLinkUrl,
    businessName: opts.businessName ?? null,
  });
  return sent
    ? { ok: true }
    : { ok: false, error: 'email send failed (see server logs)' };
}
