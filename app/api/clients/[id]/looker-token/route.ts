/**
 * POST   /api/clients/[id]/looker-token — generate a fresh token,
 *                                          replacing any existing one.
 * DELETE /api/clients/[id]/looker-token — revoke the current token.
 *
 * Tokens authenticate the public Looker Studio export endpoint
 * (/api/exports/looker?token=...). 32-char random string from
 * crypto.randomUUID() compacted; entropy is more than enough for a
 * read-only data feed.
 *
 * Both routes are agency-gated.
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

function generateToken(): string {
  // 24 bytes → 32 base64url chars. Stripping = padding so the token
  // round-trips cleanly through query params without encoding.
  return randomBytes(24).toString('base64url');
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;
  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const token = generateToken();
  const { error } = await supabase
    .from('clients')
    .update({ looker_token: token })
    .eq('id', client.id);
  if (error) {
    return NextResponse.json(
      { error: `token generation failed: ${error.message}` },
      { status: 500 }
    );
  }

  // Build the absolute URL the operator pastes into Looker Studio
  // (or into a Sheets =IMPORTDATA cell). Looks at NEXT_PUBLIC_APP_URL
  // first, request origin second, hard-coded fallback last.
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';
  const url = `${origin}/api/exports/looker?token=${token}`;

  return NextResponse.json({ ok: true, token, url });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;
  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('clients')
    .update({ looker_token: null })
    .eq('id', client.id);
  if (error) {
    return NextResponse.json(
      { error: `revoke failed: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
