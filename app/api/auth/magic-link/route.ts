/**
 * POST /api/auth/magic-link — send a magic-link to a client portal user
 * for a SPECIFIC client. This is the per-client deep-link sign-in
 * (called from /portal/<slug>/login). The /login page uses the
 * unified /api/auth/agency-magic-link endpoint, which routes
 * automatically by account type.
 *
 * Body: { client_id: uuid, email: string }
 *
 * Pre-checks the email is on the `client_users` table for the given
 * client (using the service-role client). If it isn't, returns 403
 * instead of sending a link — saves the user from clicking a link
 * that would just dump them at the access-denied screen.
 *
 * Email styling: uses lib/auth/sendMagicLink (admin.generateLink +
 * Resend SignInLinkEmail with portal-flavor copy), NOT
 * signInWithOtp's unstyled Supabase-default mailer.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { sendMagicLink } from '@/lib/auth/sendMagicLink';
import { isAgencyDomainEmail } from '@/lib/auth/agencyDomains';
import { appOrigin } from '@/lib/urls';

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

  const admin = getServerSupabase();
  const email = parsed.email.trim().toLowerCase();

  // ─── Agency-domain bypass ───────────────────────────────────────────
  // Fourdots-domain emails get magic-link access to any client portal
  // — they're operators, not portal members. The portal page itself
  // (/portal/[slug]/page.tsx) already has matching impersonation
  // logic that flags the session with an "Agency preview" header tag
  // when no client_users membership exists but the user is in the
  // `users` table. Without this bypass an agency user couldn't reach
  // that screen via the per-client login surface.
  //
  // Auto-provision a `users` row on first hit so the post-auth check
  // resolves correctly. Mirrors the same self-provisioning the
  // unified /api/auth/agency-magic-link entrypoint does.
  if (isAgencyDomainEmail(email)) {
    // Look up the client to validate the client_id + fetch the
    // business_name for the magic-link email template's portal-flavor
    // copy.
    const { data: client } = await admin
      .from('clients')
      .select('public_id, business_name')
      .eq('id', parsed.client_id)
      .maybeSingle<{ public_id: string; business_name: string }>();
    if (!client) {
      return NextResponse.json(
        { error: 'client not found' },
        { status: 404 }
      );
    }
    // Self-provision the agency users row (idempotent on the email
    // unique constraint — 23505 means a concurrent request beat us;
    // any other code is fatal).
    const { error: provisionErr } = await admin
      .from('users')
      .insert({ email, role: 'admin' });
    if (provisionErr) {
      const code = (provisionErr as { code?: string }).code;
      if (code !== '23505') {
        return NextResponse.json(
          { error: `agency provisioning failed: ${provisionErr.message}` },
          { status: 500 }
        );
      }
    }
    const origin = appOrigin();
    const next = `/portal/${client.public_id}`;
    const result = await sendMagicLink({
      supabase: admin,
      email,
      origin,
      next,
      // No businessName tagging on agency previews — the SignInLinkEmail
      // template flips to the operator-flavor copy when null.
      businessName: null,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: `magic-link send failed: ${result.error}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, agency: true });
  }

  // ─── Standard portal-member path ────────────────────────────────────
  // Service-role check: is this email on the membership list for this
  // client?
  const { data: row } = await admin
    .from('client_users')
    .select('id, email, client_id, clients ( public_id, business_name )')
    .eq('client_id', parsed.client_id)
    .eq('email', email)
    .maybeSingle<{
      id: string;
      email: string;
      client_id: string;
      clients: { public_id: string; business_name: string } | null;
    }>();

  if (!row || !row.clients) {
    return NextResponse.json(
      {
        error:
          'this email is not authorized to view this client portal — contact your account manager',
      },
      { status: 403 }
    );
  }

  const origin = appOrigin();
  const next = `/portal/${row.clients.public_id}`;

  const result = await sendMagicLink({
    supabase: admin,
    email,
    origin,
    next,
    businessName: row.clients.business_name,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: `magic-link send failed: ${result.error}` },
      { status: 502 }
    );
  }

  // Stamp invited_at so the agency UI shows "invited <date>" rather than
  // "not signed in yet" for users who used the deep-link entry point.
  await admin
    .from('client_users')
    .update({ invited_at: new Date().toISOString() })
    .eq('id', row.id);

  return NextResponse.json({ ok: true });
}
