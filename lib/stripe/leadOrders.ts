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
    // Cohort + prospect attribution from session.metadata. Critical
    // for the warm-cohort suppression rules on /order/success +
    // dashboard (cohort='crm_reactivation_q2' hides the audit upsell
    // panel + Pulse attach panel). Reading these off the row's
    // stripe_metadata is faster than re-fetching the Stripe session
    // every dashboard load.
    cohort: session.cohort,
    prospect_id: session.prospectId,
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

  // Conflict path: row already existed. Merge cohort + prospect_id
  // into its stripe_metadata so the dashboard + /order/success can
  // read those keys on subsequent page loads. This handles two cases:
  //   1. Rows created before this commit (pre-cohort-attribution)
  //      that don't have cohort stamped — backfill via re-page-load.
  //   2. Rows where the session metadata changed (e.g. operator
  //      re-launched the buyer with a different cohort lander).
  // Only the two keys we care about are written; other keys in the
  // existing metadata are preserved.
  if (insertError && insertError.code === '23505') {
    const { data: existing } = await supabase
      .from('lead_orders')
      .select('stripe_metadata')
      .eq('stripe_session_id', session.sessionId)
      .maybeSingle<{ stripe_metadata: Record<string, unknown> | null }>();
    if (existing) {
      const merged = {
        ...(existing.stripe_metadata ?? {}),
        cohort: session.cohort,
        prospect_id: session.prospectId,
      };
      await supabase
        .from('lead_orders')
        .update({ stripe_metadata: merged })
        .eq('stripe_session_id', session.sessionId);
    }
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
 *  created, transitions status from 'pending' → 'fulfilled'.
 *
 *  When `metadataPatch` is provided, merges its keys into the
 *  existing stripe_metadata JSONB. Used by the audit fulfill path
 *  to stamp `audit_call_status: 'unbooked'` so the
 *  /api/cron/audit-call-reminders job can find buyers who haven't
 *  booked yet. */
export async function markLeadOrderFulfilled(
  supabase: SupabaseLike,
  sessionId: string,
  clientId: string,
  metadataPatch?: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  // If a metadata patch is supplied, fold it into the existing
  // stripe_metadata. Two roundtrips (read then write) keeps the
  // merge logic in app code rather than relying on PG's jsonb
  // patch ops — fine because this is a low-volume per-order path.
  let mergedMetadata: Record<string, unknown> | null = null;
  if (metadataPatch) {
    const { data: existing } = await supabase
      .from('lead_orders')
      .select('stripe_metadata')
      .eq('stripe_session_id', sessionId)
      .maybeSingle<{ stripe_metadata: Record<string, unknown> | null }>();
    mergedMetadata = {
      ...(existing?.stripe_metadata ?? {}),
      ...metadataPatch,
    };
  }

  const update: Record<string, unknown> = {
    status: 'fulfilled',
    client_id: clientId,
  };
  if (mergedMetadata) update.stripe_metadata = mergedMetadata;

  const { error } = await supabase
    .from('lead_orders')
    .update(update)
    .eq('stripe_session_id', sessionId);

  if (error) {
    console.error('[lead_orders] markLeadOrderFulfilled failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Patch stripe_metadata on a lead_orders row identified by client_id.
 * Used by the Cal.com webhook to flip audit_call_status from
 * 'unbooked' → 'booked' (or 'cancelled') and by the reminder cron
 * to stamp audit_call_reminded_at.
 *
 * Idempotent — the merge means re-running with the same patch is a
 * no-op against existing keys and additive against new ones.
 */
export async function patchLeadOrderMetadataByClientId(
  supabase: SupabaseLike,
  clientId: string,
  metadataPatch: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing, error: readErr } = await supabase
    .from('lead_orders')
    .select('id, stripe_metadata')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      stripe_metadata: Record<string, unknown> | null;
    }>();
  if (readErr) {
    console.error(
      '[lead_orders] patchLeadOrderMetadataByClientId read failed',
      readErr
    );
    return { ok: false, error: readErr.message };
  }
  if (!existing) {
    return { ok: false, error: 'no lead_orders row for this client' };
  }
  const merged = {
    ...(existing.stripe_metadata ?? {}),
    ...metadataPatch,
  };
  const { error } = await supabase
    .from('lead_orders')
    .update({ stripe_metadata: merged })
    .eq('id', existing.id);
  if (error) {
    console.error(
      '[lead_orders] patchLeadOrderMetadataByClientId update failed',
      error
    );
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
