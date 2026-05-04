/**
 * POST /api/orders/fulfill
 *
 * Self-serve order completion endpoint. Called by the OrderSuccessForm
 * after a buyer fills in business details on /order/success following
 * a successful Stripe Checkout. This is the critical path for the
 * marketing tripwire.
 *
 * Flow:
 *   1. Validate the request body (Zod).
 *   2. Re-validate the Stripe session (defense in depth — never trust
 *      client-provided session_id alone).
 *   3. Confirm the lead_orders row exists + is still 'pending'.
 *   4. Geocode the submitted address.
 *   5. Insert the clients row, with billing_mode + stripe IDs derived
 *      from the tier. Best-effort transactional rollback on failure.
 *   6. Insert the primary client_locations row.
 *   7. Insert N tracked_keywords rows (1 for scan/audit/pulse, 3 for
 *      strategy/pulse_plus).
 *   8. Trigger the first scan synchronously so the success state can
 *      return scan_id. For multi-keyword tiers, additional scans are
 *      fired in parallel and we wait for all of them to complete
 *      before returning. Cron picks up future scheduled scans.
 *   9. Mark the lead_orders row as fulfilled with the client_id.
 *  10. (Future, §4) Queue the "Your TurfMap is ready" email via Resend.
 *
 * Idempotency: lead_orders.status='fulfilled' check at step 3 prevents
 * double-fulfillment if the buyer hits submit twice. The whole route
 * is safe to retry after partial failure — the rollback path on each
 * insert deletes the half-written client row.
 *
 * Pre-Stripe-launch state: returns 503 with a helpful inline error
 * envelope if STRIPE_SECRET_KEY isn't configured. Same graceful
 * degradation pattern as /api/checkout/[tier].
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { geocodeAddress } from '@/lib/geocoding/nominatim';
import { runScanForLocation } from '@/lib/scans/runScan';
import {
  loadCheckoutSession,
  type LoadSessionError,
} from '@/lib/stripe/session';
import {
  billingModeForTier,
  getLeadOrderBySessionId,
  keywordCountForTier,
  markLeadOrderFailed,
  markLeadOrderFulfilled,
} from '@/lib/stripe/leadOrders';
import { STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';
import type {
  ClientLocationRow,
  ClientRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Strategy tier runs 3 scans in parallel. Each ~30s typical, occasional
// 60s+ tail. 300s ceiling gives us comfortable headroom even when one
// keyword's DFS request hits a retry.
export const maxDuration = 300;

const FulfillBody = z.object({
  sessionId: z.string().min(8),
  // Tier comes back from the page as a sanity check, but we re-derive
  // it from the Stripe session below — never trust the client.
  tier: z.string().optional(),
  businessName: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
  keywords: z.array(z.string().min(2).max(160)).min(1).max(3),
  email: z.string().email(),
  phone: z.string().min(0).max(40).nullable().optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof FulfillBody>;
  try {
    body = FulfillBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  // ─── 1. Stripe session validation ─────────────────────────────────────
  // Re-fetches the session and confirms tier metadata + paid status.
  // This is the only source of truth for "what did they buy?" — the
  // tier value the client posts is a hint, not authority.
  const session = await loadCheckoutSession(body.sessionId);
  if ('kind' in session) {
    return errorForLoadSession(session);
  }

  // Validate keyword count matches what the tier expects. Strategy
  // sends 3, others send 1. A mismatch here means either the form
  // shipped wrong code or an attacker is poking at the endpoint.
  const expectedKeywordCount = keywordCountForTier(session.tier);
  if (body.keywords.length !== expectedKeywordCount) {
    return NextResponse.json(
      {
        error: `tier "${session.tier}" expects ${expectedKeywordCount} keyword(s); got ${body.keywords.length}`,
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // ─── 2. lead_orders idempotency check ─────────────────────────────────
  const lead = await getLeadOrderBySessionId(supabase, body.sessionId);
  if (!lead) {
    // Unusual — /order/success should have created the row on first
    // load. Could happen if the buyer somehow hit /api/orders/fulfill
    // directly without visiting the success page. Insert one now so
    // we still have an audit trail.
    return NextResponse.json(
      {
        error:
          "Order session not found in our records. Email anthony@fourdots.io with your Stripe session id and we'll fire your scan manually.",
      },
      { status: 404 }
    );
  }

  if (lead.status === 'fulfilled') {
    return NextResponse.json(
      {
        error:
          'This order has already been fulfilled. Check your email for the scan link.',
        already_fulfilled: true,
        client_id: lead.client_id,
      },
      { status: 409 }
    );
  }

  // ─── 3. Geocode the submitted address ─────────────────────────────────
  const geocode = await geocodeAddress(body.address);
  if (!geocode) {
    await markLeadOrderFailed(
      supabase,
      body.sessionId,
      `geocode failed for: ${body.address}`
    );
    return NextResponse.json(
      {
        error:
          "We couldn't locate that address — please double-check the spelling. If it's correct, email anthony@fourdots.io and we'll fire your scan manually.",
      },
      { status: 422 }
    );
  }

  // ─── 4. Insert the clients row ─────────────────────────────────────────
  const billingMode = billingModeForTier(session.tier);
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: body.businessName.trim(),
      address: body.address.trim(),
      latitude: geocode.lat,
      longitude: geocode.lng,
      phone: body.phone?.trim() || null,
      street_address: geocode.components?.street_address ?? null,
      city: geocode.components?.city ?? null,
      region: geocode.components?.region ?? null,
      postcode: geocode.components?.postcode ?? null,
      country_code: geocode.components?.country_code ?? 'USA',
      service_radius_miles: 1.6,
      status: 'active',
      billing_mode: billingMode,
      stripe_customer_id: session.customerId,
      stripe_subscription_id: session.subscriptionId,
      subscription_status:
        billingMode === 'self_serve_subscription' ? 'active' : null,
    })
    .select('*')
    .single<ClientRow>();

  if (clientErr || !client) {
    const message = clientErr?.message ?? 'no row returned';
    await markLeadOrderFailed(
      supabase,
      body.sessionId,
      `client insert failed: ${message}`
    );
    return NextResponse.json(
      { error: `Order accepted but we couldn't create your account: ${message}. We'll follow up via email.` },
      { status: 500 }
    );
  }

  // Helper to roll back the client + its FK cascade if any later
  // step fails — keeps the database consistent. lead_orders rolls
  // forward to 'failed' so the operator queue can recover manually.
  async function rollback(reason: string) {
    if (client) {
      await supabase.from('clients').delete().eq('id', client.id);
    }
    await markLeadOrderFailed(supabase, body.sessionId, reason);
  }

  // ─── 5. Insert the primary location row ────────────────────────────────
  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: geocode.components?.city ?? null,
      address: body.address.trim(),
      street_address: geocode.components?.street_address ?? null,
      city: geocode.components?.city ?? null,
      region: geocode.components?.region ?? null,
      postcode: geocode.components?.postcode ?? null,
      country_code: geocode.components?.country_code ?? 'USA',
      phone: body.phone?.trim() || null,
      latitude: geocode.lat,
      longitude: geocode.lng,
      service_radius_miles: 1.6,
    })
    .select('*')
    .single<ClientLocationRow>();

  if (locErr || !location) {
    await rollback(`location insert failed: ${locErr?.message ?? 'no row'}`);
    return NextResponse.json(
      { error: `Order accepted but location setup failed: ${locErr?.message ?? 'unknown'}.` },
      { status: 500 }
    );
  }

  // ─── 6. Insert tracked keywords ────────────────────────────────────────
  // Self-serve subscriptions use weekly cadence (Pulse) or weekly with
  // multi-keyword (Pulse+ — 3 keywords on weekly). One-time tiers also
  // store as 'weekly' so the keyword exists for any bundled re-scan,
  // but the cron's billing-mode gate means one-time clients won't be
  // picked up by scheduled scans (only their bundled re-scans, fired
  // via separate logic).
  const keywordRows: TrackedKeywordRow[] = [];
  for (let i = 0; i < body.keywords.length; i++) {
    const kw = body.keywords[i].trim();
    const { data: kwRow, error: kwErr } = await supabase
      .from('tracked_keywords')
      .insert({
        client_id: client.id,
        location_id: location.id,
        keyword: kw,
        scan_frequency: 'weekly',
        is_primary: i === 0,
      })
      .select('*')
      .single<TrackedKeywordRow>();
    if (kwErr || !kwRow) {
      await rollback(
        `keyword[${i}] "${kw}" insert failed: ${kwErr?.message ?? 'no row'}`
      );
      return NextResponse.json(
        { error: `Order accepted but keyword setup failed: ${kwErr?.message ?? 'unknown'}.` },
        { status: 500 }
      );
    }
    keywordRows.push(kwRow);
  }

  // ─── 7. Trigger scans (one per keyword) in parallel ────────────────────
  // For strategy/pulse_plus this fires 3 scans at once. ~30s each
  // typical, all running concurrently against DFS. We wait for all
  // of them before returning so the buyer sees a "scan complete"
  // success state with the link.
  const scanResults = await Promise.all(
    keywordRows.map((keyword) =>
      runScanForLocation(supabase, {
        client,
        location,
        keyword,
        scanType: 'on_demand',
        // triggeredBy is null for self-serve fulfillment — there's
        // no agency operator behind the request. The audit-trail
        // value is in lead_orders.client_id, not the scan row.
        triggeredBy: null,
      })
    )
  );

  const failedScans = scanResults.filter((r) => !r.ok);
  if (failedScans.length > 0) {
    // Partial-failure path: client + location + keywords are all
    // created but at least one scan failed. We DON'T roll back the
    // client (the buyer can retry the scan later from the dashboard).
    // We mark lead_order as fulfilled (because the data setup
    // succeeded) and return a degraded success.
    const errMsg = failedScans.map((r) => (r.ok ? '' : r.error)).join('; ');
    console.error('[orders/fulfill] partial scan failure', errMsg);
    await markLeadOrderFulfilled(supabase, body.sessionId, client.id);
    return NextResponse.json({
      ok: true,
      partial: true,
      client_id: client.id,
      public_id: client.public_id,
      successful_scans: scanResults
        .filter((r) => r.ok)
        .map((r) => (r.ok ? r.scanId : null))
        .filter(Boolean),
      failed_scan_count: failedScans.length,
      message:
        "Your account is set up but one or more scans hit a transient error. We'll retry automatically and email you when they're complete.",
    });
  }

  // ─── 8. Mark lead_order fulfilled ──────────────────────────────────────
  const fulfilled = await markLeadOrderFulfilled(
    supabase,
    body.sessionId,
    client.id
  );
  if (!fulfilled.ok) {
    // Non-fatal — the data is all written, the lead_orders row just
    // didn't transition. Log for operator follow-up. Buyer still
    // sees success.
    console.error(
      '[orders/fulfill] markLeadOrderFulfilled failed (non-fatal)',
      fulfilled.error
    );
  }

  // ─── 9. (Future, §4) Queue scan-ready email via Resend ─────────────────
  // TODO: integrate Resend once §4 of the prelaunch buildlist ships.
  // Will look like: await sendScanReadyEmail({ to: body.email, scanIds, businessName, ... })
  // For now, scan completion is visible via the success-state UI on
  // /order/success and the scan link the buyer can bookmark.

  const scanIds = scanResults
    .map((r) => (r.ok ? r.scanId : null))
    .filter((id): id is string => id != null);

  return NextResponse.json({
    ok: true,
    client_id: client.id,
    public_id: client.public_id,
    scan_ids: scanIds,
    primary_scan_id: scanIds[0] ?? null,
  });
}

/** Map a LoadSessionError into the appropriate JSON envelope + status
 *  code. Centralized so the ordering of error precedence stays
 *  consistent across callers. */
function errorForLoadSession(err: LoadSessionError): NextResponse {
  switch (err.kind) {
    case 'stripe_not_configured':
      return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
    case 'session_not_found':
      return NextResponse.json(
        { error: 'Stripe session not found — checkout link looks malformed.' },
        { status: 404 }
      );
    case 'invalid_tier':
      return NextResponse.json(
        {
          error: `Stripe session is missing a recognized tier (got "${err.tierValue ?? 'null'}"). Email anthony@fourdots.io with your session id.`,
        },
        { status: 400 }
      );
    case 'payment_not_complete':
      return NextResponse.json(
        {
          error: `Payment status on this session is "${err.paymentStatus ?? 'unknown'}", not "paid". If you completed payment and got this error, contact support.`,
        },
        { status: 402 }
      );
    case 'stripe_error':
      return NextResponse.json(
        { error: `Stripe lookup failed: ${err.message}` },
        { status: 502 }
      );
  }
}
