/**
 * POST /api/portal/upgrade
 *
 * Self-serve Pulse → Pulse+ upgrade from the client portal. Same Stripe
 * call as /api/subscription/upgrade but gated by client_users
 * membership instead of agency-staff auth — the buyer hits this from
 * their own portal page.
 *
 * Body: { client_id, cadence?: 'monthly' | 'annual' }
 *
 * Auth check:
 *   1. Supabase auth user must exist on the request cookies.
 *   2. Their email must be in client_users for parsed.client_id.
 *   3. Agency staff bypass (operator preview / support intervention).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';
import { updateSubscriptionPrice } from '@/lib/stripe/subscription';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
  cadence: z.enum(['monthly', 'annual']).optional(),
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

  const cadence = parsed.cadence ?? 'monthly';
  const priceEnvKey =
    cadence === 'annual'
      ? 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL'
      : 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY';
  const priceId = process.env[priceEnvKey];
  if (!priceId) {
    return NextResponse.json(
      { error: 'Pulse+ pricing not yet available. Contact support.' },
      { status: 503 }
    );
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, stripe_subscription_id, billing_mode, tier')
    .eq('id', parsed.client_id)
    .maybeSingle<
      Pick<ClientRow, 'id' | 'stripe_subscription_id' | 'billing_mode' | 'tier'>
    >();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  if (
    client.billing_mode !== 'self_serve_subscription' ||
    !client.stripe_subscription_id
  ) {
    return NextResponse.json(
      { error: 'no upgradeable subscription on file. Contact support.' },
      { status: 400 }
    );
  }
  if (client.tier === 'pulse_plus') {
    return NextResponse.json(
      { error: 'Already on Pulse+.' },
      { status: 400 }
    );
  }

  const result = await updateSubscriptionPrice({
    subscriptionId: client.stripe_subscription_id,
    newPriceId: priceId,
  });
  if (!result.ok) {
    const status = result.kind === 'stripe_not_configured' ? 503 : 502;
    return NextResponse.json({ error: result.message }, { status });
  }

  await supabase
    .from('clients')
    .update({ tier: 'pulse_plus' })
    .eq('id', client.id);

  return NextResponse.json({ ok: true, tier: 'pulse_plus' });
}
