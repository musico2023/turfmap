/**
 * Citation maintenance lifecycle helpers.
 *
 * Tier-downgrade hook: when a client moves from Pulse+ → Pulse (or
 * cancels entirely), we stop paying BrightLocal for ongoing
 * directory sync but leave the existing live citations in place.
 * The buyer keeps their listings; we just stop maintaining them.
 *
 * Two callers:
 *
 *   1. PATCH /api/clients/[id] — when an operator manually flips the
 *      client status to 'churned' from the agency settings UI. Fires
 *      synchronously inside the route so the operator gets immediate
 *      feedback.
 *
 *   2. Stripe webhook (TODO, item 2 in roadmap) — fires on
 *      `customer.subscription.deleted` and on `subscription.updated`
 *      when the new plan is the Pulse Price (not Pulse+). Plumbed
 *      through this same helper so behavior stays consistent
 *      regardless of whether the trigger was operator-side or
 *      buyer-side.
 *
 * Side effects:
 *   - Sets citation_orders.maintenance_paused = true for every open
 *     row tied to the client.
 *   - Calls BL's pause endpoint per row (best-effort; failures are
 *     logged but don't block the local pause). Keeps BL from billing
 *     us for ongoing sync on those orders.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { pauseMaintenance } from '@/lib/brightlocal/citationBuilder';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';
import type {
  CitationOrderRow,
  CitationSubmittedProfile,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type PauseResult = {
  paused: number;
  blFailures: Array<{ orderId: string; message: string }>;
};

/**
 * Pause maintenance on every open citation order for a client.
 * Idempotent — already-paused rows are skipped.
 */
export async function pauseClientCitationMaintenance(
  supabase: SupabaseLike,
  clientId: string
): Promise<PauseResult> {
  const { data: openOrders } = await supabase
    .from('citation_orders')
    .select('id, provider, brightlocal_order_id, ghl_location_id, submitted_profile')
    .eq('client_id', clientId)
    .eq('maintenance_paused', false)
    .returns<
      Pick<
        CitationOrderRow,
        | 'id'
        | 'provider'
        | 'brightlocal_order_id'
        | 'ghl_location_id'
        | 'submitted_profile'
      >[]
    >();

  const orders = openOrders ?? [];
  const blFailures: PauseResult['blFailures'] = [];

  // Update local rows first so the UI reflects the paused state
  // immediately. Vendor-side stops are best-effort — even if they fail,
  // our billing surface (citation_orders.maintenance_paused) is correct.
  if (orders.length > 0) {
    await supabase
      .from('citation_orders')
      .update({
        maintenance_paused: true,
        updated_at: new Date().toISOString(),
      })
      .in(
        'id',
        orders.map((o) => o.id)
      );
  }

  for (const o of orders) {
    if (o.provider === 'ghl_listings') {
      // GHL bills $30/mo wholesale for as long as Listings is toggled ON
      // for the sub-account, and there's no public API for the toggle —
      // ping the operator so the wholesale spend actually stops. Fail-soft
      // (the local pause already happened; the ping is the money-saver).
      const name =
        (o.submitted_profile as CitationSubmittedProfile | null)
          ?.business_name ?? 'unknown business';
      try {
        await postOperatorSlack({
          text: `🛑 Citations churn: ${name} paused. Toggle Listings OFF for GHL sub-account ${o.ghl_location_id ?? '(id unknown — find by name)'} to stop the $30/mo wholesale.`,
        });
      } catch {
        console.error(
          `[citations/maintenance] Slack ping failed for GHL order ${o.id} — Listings must be toggled OFF manually`
        );
      }
      continue;
    }
    // BrightLocal rows: call BL pause so they stop billing us for sync.
    // Errors are logged + collected but don't block the operation.
    if (!o.brightlocal_order_id) continue;
    const result = await pauseMaintenance(o.brightlocal_order_id);
    if (!result.ok && result.kind !== 'not_configured') {
      blFailures.push({ orderId: o.id, message: result.message });
      console.error(
        `[citations/maintenance] BL pause failed for order ${o.id}: ${result.message}`
      );
    }
  }

  return { paused: orders.length, blFailures };
}
