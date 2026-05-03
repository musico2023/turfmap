/**
 * Stripe Checkout session helpers.
 *
 * Both the order-success page (server component) and the order-fulfill
 * API need to look up a Stripe Checkout session and extract the same
 * fields (tier, customer email, payment status, customer id, amount).
 * This module is the single place that knows the session shape.
 */

import { getStripe } from './client';
import type { Tier } from '@/lib/supabase/types';

export type LoadedSession = {
  /** The original session id (round-trips for downstream calls). */
  sessionId: string;
  /** Product tier — sourced from session.metadata.tier set by
   *  /api/checkout/[tier] when creating the session. Validated
   *  against the Tier union here so downstream code never has to
   *  re-check. */
  tier: Tier;
  /** Buyer email — checkout sessions store this on session.customer_details
   *  for both one-time AND subscription mode. Used to pre-fill the
   *  fulfill form + send the confirmation email. */
  customerEmail: string | null;
  /** Stripe Customer object id. For one-time payments this is set
   *  when customer_creation='if_required' captured a customer; for
   *  subscriptions it's always set. */
  customerId: string | null;
  /** Subscription id, only present for subscription-mode sessions. */
  subscriptionId: string | null;
  /** 'paid' / 'unpaid' / 'no_payment_required' — only proceed if 'paid'. */
  paymentStatus: string | null;
  /** Cents. For audit-tier surfacing in lead_orders.stripe_metadata
   *  + analytics. */
  amountTotal: number | null;
  /** ISO currency code. */
  currency: string | null;
};

/** Errors callers should distinguish: we want a clean way to know
 *  whether we 4xx (bad input) vs 503 (unconfigured) vs 502 (Stripe
 *  errored). */
export type LoadSessionError =
  | { kind: 'stripe_not_configured' }
  | { kind: 'invalid_tier'; tierValue: string | null }
  | { kind: 'session_not_found' }
  | { kind: 'payment_not_complete'; paymentStatus: string | null }
  | { kind: 'stripe_error'; message: string };

const TIER_VALUES: ReadonlySet<Tier> = new Set<Tier>([
  'scan',
  'audit',
  'strategy',
  'pulse',
  'pulse_plus',
]);

function isTier(value: string | null | undefined): value is Tier {
  return value != null && TIER_VALUES.has(value as Tier);
}

/**
 * Fetch a Stripe Checkout session and validate it for fulfillment.
 *
 * Caller pattern:
 *   const result = await loadCheckoutSession(sessionId);
 *   if ('kind' in result) { return errorEnvelope(result); }
 *   // result is a LoadedSession — proceed.
 *
 * The dual-return shape lets us preserve type safety on the success
 * branch while giving callers structured error info to format
 * appropriate HTTP responses (503 / 400 / 502).
 */
export async function loadCheckoutSession(
  sessionId: string
): Promise<LoadedSession | LoadSessionError> {
  const stripe = await getStripe();
  if (!stripe) return { kind: 'stripe_not_configured' };

  let session: import('stripe').Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      // Expand customer details so we get the email even when no
      // Customer object was created (one-time payments without
      // customer_creation can leave customer_details populated and
      // customer null).
      expand: ['customer', 'subscription'],
    });
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : 'unknown';
    // Stripe 404s come through with a code we could match on, but
    // for our purposes either "not found" or "wrong account" land
    // here. session_not_found is the right user-facing framing.
    if (message.toLowerCase().includes('no such checkout.session')) {
      return { kind: 'session_not_found' };
    }
    return { kind: 'stripe_error', message };
  }

  const tierRaw =
    session.metadata && 'tier' in session.metadata
      ? String(session.metadata.tier)
      : null;
  if (!isTier(tierRaw)) {
    return { kind: 'invalid_tier', tierValue: tierRaw };
  }

  if (session.payment_status !== 'paid') {
    return {
      kind: 'payment_not_complete',
      paymentStatus: session.payment_status ?? null,
    };
  }

  // customer can come back as either a string id or an expanded
  // Customer object; normalize to string id either way.
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer && 'id' in session.customer
        ? session.customer.id
        : null;

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription && 'id' in session.subscription
        ? session.subscription.id
        : null;

  const customerEmail =
    session.customer_details?.email ??
    (typeof session.customer === 'object' &&
    session.customer &&
    'email' in session.customer
      ? session.customer.email
      : null) ??
    null;

  return {
    sessionId,
    tier: tierRaw,
    customerEmail,
    customerId,
    subscriptionId,
    paymentStatus: session.payment_status ?? null,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
  };
}
