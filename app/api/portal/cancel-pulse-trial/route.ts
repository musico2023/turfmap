/**
 * POST /api/portal/cancel-pulse-trial
 *
 * Portal-user-facing one-click cancellation for the post-purchase
 * Pulse trial. Auth: Supabase user must be either a member of
 * client_users for this client OR an agency staff user (the same
 * gate /portal/[slug] uses).
 *
 * Body: { clientPublicId: string }
 *
 * Response:
 *   200 { ok: true, cancelsAt: ISO8601 string }   trial cancellation scheduled
 *   4xx { error: string }
 *
 * Mechanic — cancel_at_period_end during trial:
 *
 *   Stripe lets us either (a) immediately cancel the subscription
 *   or (b) set cancel_at_period_end=true. For trials, both result
 *   in no charge — Stripe never bills during the trial regardless.
 *   The difference:
 *
 *     - Immediate cancel: Pulse features stop NOW. The buyer loses
 *       the remaining trial days (e.g. cancels on day 5, loses 25
 *       days of free Pulse access).
 *     - cancel_at_period_end: trial runs to day 30, then the sub
 *       deletes without the day-31 charge. Buyer gets full trial
 *       value + zero risk.
 *
 *   Going with (b). The buyer's actual intent is "don't bill me on
 *   day 31," not "stop Pulse immediately" — and giving them the
 *   full trial window is the right side of the trust line. Stripe
 *   webhook fires customer.subscription.deleted at trial end →
 *   our existing markCancelled handler flips status to 'canceled'.
 *
 *   The webhook also fires customer.subscription.updated at the
 *   moment of THIS cancel (cancel_at_period_end transitioning from
 *   false to true). We don't write a separate field for that — the
 *   buyer's portal reads cancel_at_period_end live from Stripe via
 *   the billing summary endpoint, so the UI auto-reflects.
 *
 * Tracking: fires GA4 trial_canceled_before_day_31 server-side via
 * Measurement Protocol so the funnel can attribute cancellations
 * to the right source campaign.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';
import { cancelAtPeriodEnd } from '@/lib/stripe/subscription';
import { fireMeasurementProtocolEvent } from '@/lib/analytics/measurementProtocol';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  clientPublicId: z.string().min(1),
});

export async function POST(req: Request) {
  // Portal-user auth — Supabase session must exist.
  const auth = await getAuthSupabase();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const userEmail = (user.email ?? '').toLowerCase();

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

  // Resolve client by public_id, capture subscription state.
  const admin = getServerSupabase();
  const { data: client } = await admin
    .from('clients')
    .select(
      'id, public_id, stripe_subscription_id, stripe_customer_id, billing_mode, tier, subscription_status'
    )
    .eq('public_id', parsed.clientPublicId)
    .maybeSingle<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'stripe_subscription_id'
        | 'stripe_customer_id'
        | 'billing_mode'
        | 'tier'
        | 'subscription_status'
      >
    >();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Membership gate: same dual check as /portal/[slug] — either a
  // client_users row for this (client, email) pair, or an agency
  // staff user impersonating from the dashboard.
  const [{ data: membership }, { data: agencyRow }] = await Promise.all([
    admin
      .from('client_users')
      .select('id')
      .eq('client_id', client.id)
      .eq('email', userEmail)
      .maybeSingle<{ id: string }>(),
    admin
      .from('users')
      .select('id, role')
      .eq('email', userEmail)
      .maybeSingle<{ id: string; role: string }>(),
  ]);
  if (!membership && !agencyRow) {
    return NextResponse.json(
      { error: 'forbidden — not a member of this client portal' },
      { status: 403 }
    );
  }

  // Sanity gates. cancelAtPeriodEnd handles its own version of these
  // but we want clearer error messages for the portal UI.
  if (!client.stripe_subscription_id) {
    return NextResponse.json(
      { error: 'No active Pulse subscription found.' },
      { status: 400 }
    );
  }
  if (client.tier !== 'pulse' && client.tier !== 'pulse_plus') {
    return NextResponse.json(
      { error: 'This account is not on a Pulse subscription.' },
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

  // Fire GA4 trial_canceled_before_day_31 server-side. Stripe doesn't
  // know if this is "trial cancel" vs "regular subscription cancel"
  // from its perspective — we know it because the client's status
  // was 'trialing' at the moment of cancel. The MP call is fire-
  // and-forget; failures don't block the user-facing 200.
  if (client.subscription_status === 'trialing') {
    fireMeasurementProtocolEvent({
      // GA4 client_id needs to be a UUID-shaped value that GA accepts
      // as a session anchor. Stripe customer id (cus_xxx) is unique
      // and deterministic for the buyer — using it means cancel
      // events join cleanly to attach events that also stamped it.
      clientId:
        client.stripe_customer_id ?? `client-${client.id}`,
      eventName: 'trial_canceled_before_day_31',
      params: {
        public_id: client.public_id,
        cancels_at: result.cancelsAt,
      },
    }).catch((err) => {
      console.warn('[cancel-pulse-trial] GA4 MP event failed:', err);
    });
  }

  return NextResponse.json({ ok: true, cancelsAt: result.cancelsAt });
}
