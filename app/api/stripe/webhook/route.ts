/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook ingestion. Verifies the signature with
 * STRIPE_WEBHOOK_SECRET, then dispatches subscription-lifecycle
 * events to keep clients.tier + subscription_status in sync without
 * the operator having to flip anything by hand.
 *
 * Handled events:
 *   customer.subscription.created  — first sub for this customer.
 *                                    Resolve tier from price.id, set
 *                                    tier + subscription_status +
 *                                    stripe_subscription_id on the
 *                                    matching client row.
 *   customer.subscription.updated  — Stripe-side change (price swap,
 *                                    cancel scheduled, status change).
 *                                    Re-resolve tier + status. Catches
 *                                    upgrades and downgrades initiated
 *                                    in the Stripe Customer Portal.
 *   customer.subscription.deleted  — sub fully ended. Set status to
 *                                    'canceled' and clear tier so
 *                                    feature gates close immediately.
 *   invoice.payment_failed          — set subscription_status to
 *                                    'past_due' so the UI can warn.
 *                                    Stripe still retries automatically;
 *                                    .updated will fire again with the
 *                                    final status.
 *
 * Lookup strategy:
 *   - All four events carry the Customer id. We match by
 *     clients.stripe_customer_id (set during /api/orders/fulfill on
 *     first checkout). If no client matches, we log + 200 — we
 *     don't 4xx Stripe because retried unhandleable events would
 *     pile up in their dashboard's "failed deliveries" view.
 *
 * Idempotency: Stripe retries failed deliveries. The handlers below
 * are write-then-replace on a single column set, so duplicate
 * events converge to the same row state.
 *
 * IMPORTANT: this route reads the raw request body for signature
 * verification. Don't call req.json() — use req.text() and feed
 * the string into stripe.webhooks.constructEvent.
 */

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe/client';
import { getServerSupabase } from '@/lib/supabase/server';
import { tierFromPriceId } from '@/lib/stripe/tierFromPrice';
import type {
  ClientRow,
  SubscriptionStatus,
  SubscriptionTier,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';

// Stripe wants the raw body — Next.js App Router gives us a Request
// where we can read .text() before any JSON parsing. Don't add a
// route segment config to disable parsing; req.text() works regardless.

export async function POST(req: Request) {
  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: 'Stripe not configured (STRIPE_SECRET_KEY missing)' },
      { status: 503 }
    );
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'STRIPE_WEBHOOK_SECRET not set' },
      { status: 503 }
    );
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json(
      { error: 'missing stripe-signature header' },
      { status: 400 }
    );
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `signature verification failed: ${msg}` },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(supabase, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await markCancelled(supabase, sub);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await markPastDue(supabase, invoice);
        break;
      }
      // Other events (checkout.session.completed, invoice.paid, etc.)
      // are intentionally ignored here — checkout fulfillment lives
      // in /api/orders/fulfill and runs on the success page; if a
      // buyer never lands there, this webhook is the safety net we'd
      // wire next.
      default:
        break;
    }
  } catch (e) {
    // Log and 500 so Stripe retries. The handlers above are
    // idempotent so a retry converges.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[stripe-webhook] ${event.type} failed:`, msg);
    return NextResponse.json(
      { error: `handler failed for ${event.type}: ${msg}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true, type: event.type });
}

// ─── Handlers ─────────────────────────────────────────────────────────────

type SupabaseLike = ReturnType<typeof getServerSupabase>;

/** Resolve tier by scanning ALL items on the subscription for one
 *  matching a known base-tier price ID. Multi-item subs (post per-
 *  location billing) carry a base item AND an extra-location item;
 *  the base item is what determines the tier. Stripe doesn't
 *  guarantee item ordering, so iterating beats reading items[0].
 *
 *  Then write tier + subscription_status + stripe_subscription_id
 *  onto the client row matching the customer id. */
async function syncSubscription(
  supabase: SupabaseLike,
  sub: Stripe.Subscription
): Promise<void> {
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  if (sub.items.data.length === 0) {
    console.warn(
      `[stripe-webhook] subscription ${sub.id} has no items — skipping`
    );
    return;
  }
  let tier: ReturnType<typeof tierFromPriceId> = null;
  for (const item of sub.items.data) {
    const priceId =
      typeof item.price === 'string' ? item.price : item.price.id;
    const candidate = tierFromPriceId(priceId);
    if (candidate) {
      tier = candidate;
      break;
    }
  }
  if (!tier) {
    const allPrices = sub.items.data
      .map((i) => (typeof i.price === 'string' ? i.price : i.price.id))
      .join(', ');
    console.warn(
      `[stripe-webhook] subscription ${sub.id} has no items on a recognized tier price (saw: ${allPrices}) — skipping tier write`
    );
    return;
  }

  const status = sub.status as SubscriptionStatus;

  // Look up the client to honor agency-managed conversions. Once a
  // client is agency_managed, the operator's contract is the source
  // of truth for tier — Stripe events shouldn't overwrite it. We
  // still mirror status + sub_id so the audit trail is intact.
  const { data: existingClient } = await supabase
    .from('clients')
    .select('billing_mode')
    .eq('stripe_customer_id', customerId)
    .maybeSingle<Pick<ClientRow, 'billing_mode'>>();
  const isAgencyManaged = existingClient?.billing_mode === 'agency_managed';

  const update: Partial<
    Pick<ClientRow, 'tier' | 'subscription_status' | 'stripe_subscription_id'>
  > = isAgencyManaged
    ? {
        subscription_status: status,
        stripe_subscription_id: sub.id,
      }
    : {
        tier,
        subscription_status: status,
        stripe_subscription_id: sub.id,
      };

  const { error } = await supabase
    .from('clients')
    .update(update)
    .eq('stripe_customer_id', customerId);
  if (error) {
    throw new Error(
      `clients update failed for customer ${customerId}: ${error.message}`
    );
  }
}

async function markCancelled(
  supabase: SupabaseLike,
  sub: Stripe.Subscription
): Promise<void> {
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // Look up the client to check billing_mode. For agency-managed
  // clients (typically the result of a self-serve → managed
  // conversion via /api/clients/[id]/convert-to-managed), the
  // operator's contract is now the source of truth for tier — Stripe
  // is no longer driving it. So we ONLY mirror the canceled status,
  // leaving tier alone. For self-serve subs that were genuinely
  // canceled by the buyer, we close feature gates by clearing tier.
  const { data: client } = await supabase
    .from('clients')
    .select('billing_mode')
    .eq('stripe_customer_id', customerId)
    .maybeSingle<Pick<ClientRow, 'billing_mode'>>();
  const isAgencyManaged = client?.billing_mode === 'agency_managed';

  const update: Partial<
    Pick<ClientRow, 'tier' | 'subscription_status'>
  > = isAgencyManaged
    ? { subscription_status: 'canceled' }
    : {
        tier: null as SubscriptionTier | null,
        subscription_status: 'canceled',
      };

  const { error } = await supabase
    .from('clients')
    .update(update)
    .eq('stripe_customer_id', customerId);
  if (error) {
    throw new Error(
      `clients cancel-update failed for customer ${customerId}: ${error.message}`
    );
  }
}

async function markPastDue(
  supabase: SupabaseLike,
  invoice: Stripe.Invoice
): Promise<void> {
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;
  if (!customerId) return;
  const update: Partial<Pick<ClientRow, 'subscription_status'>> = {
    subscription_status: 'past_due',
  };
  const { error } = await supabase
    .from('clients')
    .update(update)
    .eq('stripe_customer_id', customerId);
  if (error) {
    throw new Error(
      `clients past_due-update failed for customer ${customerId}: ${error.message}`
    );
  }
}
