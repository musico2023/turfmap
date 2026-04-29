/**
 * POST /api/client_users — add a portal user (email-only, no password).
 *
 * The portal sign-in flow is magic-link — no password is set. Adding a row
 * to client_users grants this email permission to view the white-label
 * portal for that client. Removing the row revokes access.
 *
 * Body: { client_id, email }
 *
 * Constraint note: client_users has a `unique(email)` constraint at the DB
 * level (one email = one client account). Trying to add the same email
 * twice across clients returns 409 with a friendly error.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
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
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('client_users')
    .insert({
      client_id: parsed.client_id,
      email: parsed.email.trim().toLowerCase(),
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
