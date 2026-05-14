/**
 * POST /api/subscription/cancel
 *
 * Schedules cancellation for the buyer's subscription at the end of
 * the current billing period (cancel_at_period_end=true). Refuses
 * cancellation when the buyer is still in the Subscription
 * Schedule's committed first phase (Pulse+ monthly buyers in their
 * 3-month minimum) — the dashboard surfaces the end-of-commitment
 * date so the operator/buyer can see when they CAN cancel.
 *
 * Body: { client_id }
 *
 * The client_id maps to clients.stripe_subscription_id; we don't
 * accept the subscription_id directly to keep the operator UI keyed
 * off the same identifier as the rest of the dashboard.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { cancelAtPeriodEnd } from '@/lib/stripe/subscription';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
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
        {
          error: e.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data: client } = await supabase
    .from('clients')
    .select('id, stripe_subscription_id, billing_mode')
    .eq('id', parsed.client_id)
    .maybeSingle<
      Pick<ClientRow, 'id' | 'stripe_subscription_id' | 'billing_mode'>
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
          'This client is not on a self-serve subscription. Use the agency contract flow for cancellation.',
      },
      { status: 400 }
    );
  }

  const result = await cancelAtPeriodEnd(client.stripe_subscription_id);
  if (!result.ok) {
    const status =
      result.kind === 'stripe_not_configured'
        ? 503
        : result.kind === 'committed_phase'
          ? 409
          : 502;
    return NextResponse.json(
      { error: result.message, kind: result.kind },
      { status }
    );
  }

  return NextResponse.json({ ok: true, cancels_at: result.cancelsAt });
}
