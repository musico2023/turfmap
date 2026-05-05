/**
 * POST /api/subscription/upgrade
 *
 * Agency-gated Pulse → Pulse+ upgrade. Swaps the subscription's
 * Price item to Pulse+ (matching cadence) via
 * stripe.subscriptions.update with proration_behavior='always_invoice'
 * — the buyer is charged immediately for the prorated cost difference,
 * then continues at the new price going forward.
 *
 * Body: { client_id, cadence?: 'monthly' | 'annual' }
 *
 * cadence defaults to 'monthly' (matches our default Pulse subscription).
 * The local clients.tier column is NOT updated here — the Stripe webhook
 * (or the operator override at /api/clients/[id]/tier) is the source of
 * truth for that. We do, however, optimistically write tier='pulse_plus'
 * after Stripe confirms the swap so the dashboard reflects it immediately
 * without waiting for the webhook to fire.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { updateSubscriptionPrice } from '@/lib/stripe/subscription';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
  cadence: z.enum(['monthly', 'annual']).optional(),
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

  const cadence = parsed.cadence ?? 'monthly';
  const priceEnvKey =
    cadence === 'annual'
      ? 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL'
      : 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY';
  const priceId = process.env[priceEnvKey];
  if (!priceId) {
    return NextResponse.json(
      { error: `Pulse+ price not configured. Set ${priceEnvKey}.` },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();
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
      {
        error:
          'This client is not on a self-serve subscription. Upgrades flow through the agency contract for managed clients.',
      },
      { status: 400 }
    );
  }
  if (client.tier === 'pulse_plus') {
    return NextResponse.json(
      { error: 'Client is already on Pulse+.' },
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

  // Optimistic mirror — webhook will reconcile if anything diverges.
  await supabase
    .from('clients')
    .update({ tier: 'pulse_plus' })
    .eq('id', client.id);

  return NextResponse.json({ ok: true, tier: 'pulse_plus' });
}
