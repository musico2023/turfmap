/**
 * POST /api/citations/resync
 *
 * Actually fire a NAP re-sync to BrightLocal. Called after the
 * settings form's cost-preview modal returns "confirm" — body
 * carries the same proposed_profile + the cost the operator
 * confirmed at the modal. We re-compute the cost server-side and
 * reject if it diverged from the confirmed value (race protection
 * against quota changes between preview and confirm).
 *
 * Side effects (in order):
 *   1. Re-estimate cost; reject 409 if it diverged from confirmed.
 *   2. Update citation_orders.submitted_profile to the new
 *      high-churn values.
 *   3. Trigger the BL update for this order (TODO once BL API
 *      surface is verified — currently a no-op behind the
 *      CITATION_BUILDER_ENABLED flag).
 *   4. If free: decrement quota counter on client_locations.
 *      If over-cap: stamp a Stripe one-off invoice (TODO post
 *      Stripe webhook wiring — currently logs the charge).
 *
 * Body: { location_id, proposed_profile, confirmed_cost_cents }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import {
  consumeFreeResync,
  estimateResyncCost,
} from '@/lib/citations/resync';
import type {
  CitationOrderRow,
  CitationSubmittedProfile,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';

const ProposedProfile = z.object({
  business_name: z.string().min(2).max(200),
  street_address: z.string().max(200).nullable(),
  city: z.string().max(120).nullable(),
  region: z.string().max(120).nullable(),
  postcode: z.string().max(20).nullable(),
  country_code: z.string().max(3).nullable(),
  phone: z.string().max(40).nullable(),
});

const Body = z.object({
  location_id: z.string().uuid(),
  proposed_profile: ProposedProfile,
  /** The cost the operator agreed to in the confirmation modal. We
   *  compare against the server-side estimate to detect a stale
   *  preview (rare but possible if the quota reset between preview
   *  and confirm). */
  confirmed_cost_cents: z.number().int().min(0),
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

  // ─── 1. Re-estimate cost server-side ──────────────────────────────────
  const estimate = await estimateResyncCost(
    supabase,
    parsed.location_id,
    parsed.proposed_profile
  );
  if (estimate.costCents !== parsed.confirmed_cost_cents) {
    return NextResponse.json(
      {
        error:
          'Cost preview is stale — quota may have reset. Reload the form to see the current cost before confirming.',
        current_estimate: estimate,
      },
      { status: 409 }
    );
  }

  // ─── 2. Find the open citation order for this location ────────────────
  const { data: order } = await supabase
    .from('citation_orders')
    .select('*')
    .eq('location_id', parsed.location_id)
    .eq('maintenance_paused', false)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<CitationOrderRow>();

  if (!order) {
    // No open order — nothing to re-sync. Operator should run the
    // initial build first via /api/citations/build.
    return NextResponse.json(
      {
        error:
          'No open citation order for this location. Run the initial build first via the citation setup page.',
      },
      { status: 404 }
    );
  }

  // ─── 3. Update submitted_profile snapshot ─────────────────────────────
  // Only the high-churn fields change here; preserve the rest of the
  // profile (categories, hours, photos, description).
  const existing = order.submitted_profile;
  if (!existing) {
    return NextResponse.json(
      {
        error:
          'Citation order is missing its submitted profile snapshot — internal data integrity issue. Contact support.',
      },
      { status: 500 }
    );
  }
  const updatedProfile: CitationSubmittedProfile = {
    ...existing,
    business_name: parsed.proposed_profile.business_name,
    street_address: parsed.proposed_profile.street_address,
    city: parsed.proposed_profile.city,
    region: parsed.proposed_profile.region,
    postcode: parsed.proposed_profile.postcode,
    country_code: parsed.proposed_profile.country_code,
    phone: parsed.proposed_profile.phone,
  };

  await supabase
    .from('citation_orders')
    .update({
      submitted_profile: updatedProfile,
      updated_at: new Date().toISOString(),
      // billed_cents tracks accumulated over-cap charges. Stamp the
      // delta when over-cap.
      ...(estimate.free
        ? {}
        : { billed_cents: (order.billed_cents ?? 0) + estimate.costCents }),
    })
    .eq('id', order.id);

  // ─── 4. Quota decrement OR Stripe invoice ─────────────────────────────
  if (estimate.free) {
    await consumeFreeResync(supabase, parsed.location_id);
  } else {
    // TODO (post Stripe webhook wiring, item 2 in roadmap):
    // Generate a Stripe one-off invoice on the customer's existing
    // subscription:
    //   await stripe.invoiceItems.create({
    //     customer: client.stripe_customer_id,
    //     amount: estimate.costCents,
    //     currency: 'usd',
    //     description: `Citation re-sync — ${estimate.directoryCount} directories`,
    //   });
    //   await stripe.invoices.create({ customer, auto_advance: true });
    // For now we record the billed_cents on the citation_order row
    // (above) so the audit trail exists; actual money capture
    // happens once the Stripe pipe lands.
    console.log(
      `[citations/resync] over-cap charge pending Stripe invoice: ` +
        `client_id=${order.client_id} location_id=${parsed.location_id} ` +
        `cents=${estimate.costCents} dirs=${estimate.directoryCount}`
    );
  }

  // ─── 5. Trigger BL update (TODO when API surface verified) ────────────
  // The BL Citation Builder wrapper currently exposes submit / poll /
  // pause primitives. The "update existing order with new profile"
  // primitive needs to be added once we confirm the endpoint path
  // against BL developer docs. Until then this route's effect is
  // confined to the local DB — citation_orders.submitted_profile and
  // the quota counter are correct, but the directories themselves
  // won't see the new NAP until BL gets the call.
  //
  // const updateResult = await updateCitationOrder(
  //   order.brightlocal_order_id,
  //   updatedProfile
  // );
  // if (!updateResult.ok && updateResult.kind !== 'not_configured') {
  //   ...rollback or surface error...
  // }

  return NextResponse.json({
    ok: true,
    free: estimate.free,
    cost_cents: estimate.costCents,
    quota_remaining: Math.max(0, estimate.quota.remaining - (estimate.free ? 1 : 0)),
  });
}
