/**
 * POST /api/portal/billing-portal
 *
 * Client-side (portal user) Stripe Customer Portal opener. Same
 * underlying Stripe call as /api/subscription/billing-portal but
 * gated by client_users membership instead of agency-staff
 * authentication, since the buyer hits this from their own portal
 * page — they don't have agency credentials.
 *
 * Body: { client_id }   (must match a client_users row owned by the
 *                        authenticated portal user)
 *
 * Auth check:
 *   1. Supabase auth user must exist on the request cookies.
 *   2. Their email must appear in client_users for parsed.client_id.
 *   3. Agency staff bypass the client_users check (operator preview).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';
import { createBillingPortalSession } from '@/lib/stripe/subscription';
import type { ClientRow } from '@/lib/supabase/types';
import { portalUrl } from '@/lib/urls';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
});

export async function POST(req: Request) {
  const auth = await getAuthSupabase();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

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
  const userEmail = user.email.toLowerCase();
  // Membership gate. Agency staff with rows in `users` get to
  // bypass — they can preview the portal AND open the billing
  // portal as the client (useful for support).
  const [{ data: membership }, { data: agencyRow }] = await Promise.all([
    supabase
      .from('client_users')
      .select('id')
      .eq('client_id', parsed.client_id)
      .eq('email', userEmail)
      .maybeSingle<{ id: string }>(),
    supabase
      .from('users')
      .select('id')
      .eq('email', userEmail)
      .maybeSingle<{ id: string }>(),
  ]);
  if (!membership && !agencyRow) {
    return NextResponse.json(
      { error: 'no portal access for this client' },
      { status: 403 }
    );
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, public_id, stripe_customer_id')
    .eq('id', parsed.client_id)
    .maybeSingle<Pick<ClientRow, 'id' | 'public_id' | 'stripe_customer_id'>>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  if (!client.stripe_customer_id) {
    return NextResponse.json(
      { error: 'no Stripe customer on file. Contact support.' },
      { status: 400 }
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';
  const result = await createBillingPortalSession({
    customerId: client.stripe_customer_id,
    returnUrl: portalUrl(origin, client.public_id),
  });
  if (!result.ok) {
    const status = result.kind === 'stripe_not_configured' ? 503 : 502;
    return NextResponse.json({ error: result.message }, { status });
  }
  return NextResponse.json({ ok: true, url: result.url });
}
