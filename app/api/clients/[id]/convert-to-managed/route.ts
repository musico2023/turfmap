/**
 * POST /api/clients/[id]/convert-to-managed
 *
 * One-click conversion of a self-serve buyer to an agency-managed
 * client. Required when the operator decides to take a Stripe-paying
 * buyer onto a custom Local Lead Machine contract — the client's
 * Stripe sub needs to wind down so they're not double-billed, the
 * row needs to flip to billing_mode='agency_managed', and tier needs
 * to be set explicitly (since the Stripe webhook will no longer be
 * the source of truth post-conversion).
 *
 * Body:
 *   {
 *     tier: 'pulse' | 'pulse_plus',
 *     cancel_timing: 'now' | 'period_end'
 *   }
 *
 * Order of operations matters here:
 *   1. Update billing_mode='agency_managed' + set tier FIRST. This
 *      tells the webhook (which fires on cancellation) that this
 *      client is no longer Stripe-driven; the markCancelled handler
 *      then skips its tier-clearing path.
 *   2. THEN cancel the Stripe subscription per cancel_timing.
 *
 * Reverse order would race with the webhook: we cancel → webhook
 * fires `subscription.deleted` → wipes tier → operator's intended
 * tier never lands.
 *
 * If the operator wants to refund unused time, that's a separate
 * action in the Stripe dashboard. We keep it manual because refund
 * policy is a judgment call — sometimes the operator wants to absorb
 * the unused subscription credit as a goodwill gesture, sometimes
 * they want the buyer made whole.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  isAgencyOwnerEmail,
  requireAgencyUserForApi,
} from '@/lib/auth/agency';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { getStripe } from '@/lib/stripe/client';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  tier: z.enum(['pulse', 'pulse_plus']),
  cancel_timing: z.enum(['now', 'period_end']),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  // Defense in depth — UI hides the affordance to non-agency-owner
  // emails, but a request hitting the route directly still has to
  // clear the domain gate. Self-serve → agency conversion is
  // operationally significant (irreversible Stripe cancellation),
  // so we keep it scoped to fourdots.ca / fourdots.io operators.
  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json(
      {
        error:
          'Restricted action — only agency-owner accounts can convert clients to agency-managed.',
      },
      { status: 403 }
    );
  }

  const { id: clientParam } = await params;

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
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Only self-serve subscriptions are conversion targets. one_time
  // and already-agency_managed clients have nothing to convert.
  if (client.billing_mode !== 'self_serve_subscription') {
    return NextResponse.json(
      {
        error: `Client billing mode is "${client.billing_mode}". Only self-serve subscription clients can be converted to agency-managed.`,
      },
      { status: 400 }
    );
  }

  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: 'STRIPE_SECRET_KEY is not set' },
      { status: 503 }
    );
  }

  // ─── Step 1: Flip billing_mode + tier BEFORE touching Stripe ─────────
  // Why this order: cancelling the sub fires customer.subscription.{updated,
  // deleted} webhooks. The deleted handler currently nulls tier on the
  // matching client. By flipping billing_mode='agency_managed' first,
  // the updated webhook handler (which now checks billing_mode) will
  // correctly skip the tier-clearing branch — preserving the operator's
  // chosen tier across the cancellation event.
  const { error: updateError } = await supabase
    .from('clients')
    .update({
      billing_mode: 'agency_managed',
      tier: parsed.tier,
    })
    .eq('id', client.id);
  if (updateError) {
    return NextResponse.json(
      { error: `client update failed: ${updateError.message}` },
      { status: 500 }
    );
  }

  // ─── Step 2: Wind down the Stripe subscription ────────────────────────
  let cancelResult: {
    canceled: boolean;
    cancelsAt?: string;
    immediate?: boolean;
    note?: string;
  } = { canceled: false };

  if (client.stripe_subscription_id) {
    try {
      if (parsed.cancel_timing === 'now') {
        const canceled = await stripe.subscriptions.cancel(
          client.stripe_subscription_id
        );
        cancelResult = {
          canceled: true,
          immediate: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cancelsAt: new Date(((canceled as any).canceled_at ?? Date.now() / 1000) * 1000).toISOString(),
        };
      } else {
        const updated = await stripe.subscriptions.update(
          client.stripe_subscription_id,
          { cancel_at_period_end: true }
        );
        cancelResult = {
          canceled: true,
          immediate: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cancelsAt: new Date(((updated as any).current_period_end ?? 0) * 1000).toISOString(),
        };
      }
    } catch (e) {
      // Stripe failed but the row is already flipped to agency_managed.
      // Surface the error so the operator can finish manually in the
      // Stripe dashboard. This isn't a rollback condition — the agency-
      // managed flip is intentional and persists; only the sub-cancel
      // step needs operator attention.
      const msg = e instanceof Error ? e.message : String(e);
      cancelResult = {
        canceled: false,
        note: `Conversion completed but Stripe cancel failed: ${msg}. Cancel the subscription manually in the Stripe dashboard.`,
      };
    }
  } else {
    cancelResult = {
      canceled: false,
      note: 'No Stripe subscription on file — conversion completed without sub cancellation.',
    };
  }

  return NextResponse.json({
    ok: true,
    client_id: client.id,
    public_id: client.public_id,
    tier: parsed.tier,
    billing_mode: 'agency_managed',
    cancel: cancelResult,
  });
}
