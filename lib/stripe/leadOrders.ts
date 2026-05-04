/**
 * lead_orders CRUD helpers.
 *
 * Encapsulates the three lifecycle transitions a Stripe-paid order
 * goes through:
 *
 *   /order/success page load  → ensureLeadOrder()  (idempotent insert)
 *   /api/orders/fulfill ok    → markLeadOrderFulfilled()
 *   /api/orders/fulfill threw → markLeadOrderFailed()
 *
 * All write paths use the service-role Supabase client (bypasses RLS).
 * The agency-staff read policy on the table allows operators to inspect
 * pending/failed orders from the dashboard via the cookie-bound auth
 * client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LeadOrderRow, Tier } from '@/lib/supabase/types';
import type { LoadedSession } from './session';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

/**
 * Idempotent INSERT — on conflict by stripe_session_id, leaves the
 * existing row untouched and returns it. Used by /order/success page
 * load: every refresh creates a fresh attempt at writing the row, but
 * the unique constraint guarantees at most one row per session.
 *
 * Also captures email + initial Stripe metadata so an operator
 * recovering a stuck order has the buyer's contact info even if they
 * abandoned the form.
 */
export async function ensureLeadOrder(
  supabase: SupabaseLike,
  session: LoadedSession
): Promise<LeadOrderRow | null> {
  const stripeMetadata = {
    stripe_customer_id: session.customerId,
    stripe_subscription_id: session.subscriptionId,
    payment_status: session.paymentStatus,
    amount_total: session.amountTotal,
    currency: session.currency,
  };

  // Two-step: try-insert then read-back. Postgres has ON CONFLICT
  // upsert support but supabase-js's onConflict path requires
  // selecting the same shape that's being inserted — easier to just
  // try insert + ignore unique-violation, then SELECT.
  const { error: insertError } = await supabase
    .from('lead_orders')
    .insert({
      stripe_session_id: session.sessionId,
      tier: session.tier,
      email: session.customerEmail,
      status: 'pending',
      stripe_metadata: stripeMetadata,
    });

  // 23505 = unique_violation. Expected on duplicate page loads.
  // Other errors should be visible.
  if (insertError && insertError.code !== '23505') {
    console.error('[lead_orders] ensureLeadOrder insert failed', insertError);
    return null;
  }

  // Read back the row (whether we just inserted or conflicted).
  const { data, error: selectError } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('stripe_session_id', session.sessionId)
    .maybeSingle<LeadOrderRow>();

  if (selectError) {
    console.error('[lead_orders] ensureLeadOrder select failed', selectError);
    return null;
  }
  return data ?? null;
}

/** Fetch a lead_orders row by its Stripe session id. Returns null if
 *  not found — used by /api/orders/fulfill to confirm the order
 *  exists + check it hasn't already been fulfilled. */
export async function getLeadOrderBySessionId(
  supabase: SupabaseLike,
  sessionId: string
): Promise<LeadOrderRow | null> {
  const { data } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('stripe_session_id', sessionId)
    .maybeSingle<LeadOrderRow>();
  return data ?? null;
}

/** Mark a lead_order as fulfilled — writes the client_id we just
 *  created, transitions status from 'pending' → 'fulfilled'. */
export async function markLeadOrderFulfilled(
  supabase: SupabaseLike,
  sessionId: string,
  clientId: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('lead_orders')
    .update({
      status: 'fulfilled',
      client_id: clientId,
    })
    .eq('stripe_session_id', sessionId);

  if (error) {
    console.error('[lead_orders] markLeadOrderFulfilled failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Record a fulfillment failure with a free-text note. The operator
 *  recovery queue surfaces failed orders via the agency dashboard. */
export async function markLeadOrderFailed(
  supabase: SupabaseLike,
  sessionId: string,
  notes: string
): Promise<void> {
  const { error } = await supabase
    .from('lead_orders')
    .update({
      status: 'failed',
      notes,
    })
    .eq('stripe_session_id', sessionId);

  if (error) {
    console.error('[lead_orders] markLeadOrderFailed failed', error);
  }
}

/** Convenience type — the canonical mapping from tier → keyword count
 *  the form needs to collect. Strategy + Pulse+ scan three keywords;
 *  the others scan one. */
export function keywordCountForTier(tier: Tier): number {
  return tier === 'strategy' || tier === 'pulse_plus' ? 3 : 1;
}

/** Convenience type — billing_mode for a freshly-fulfilled tier. */
export function billingModeForTier(
  tier: Tier
): 'one_time' | 'self_serve_subscription' {
  return tier === 'pulse' || tier === 'pulse_plus'
    ? 'self_serve_subscription'
    : 'one_time';
}
