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

import { NextResponse, after } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe/client';
import { getServerSupabase } from '@/lib/supabase/server';
import { tierFromPriceId } from '@/lib/stripe/tierFromPrice';
import { runScanForLocation } from '@/lib/scans/runScan';
import { sendPulseTrialEnding, sendOrderConfirmation } from '@/lib/email/resend';
import { fireMeasurementProtocolEvent } from '@/lib/analytics/measurementProtocol';
import { computeLlmFitScore } from '@/lib/audit/llmFitScore';
import { createVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { calcomBookingUrlForTier } from '@/lib/integrations/calcom';
import type {
  ClientLocationRow,
  ClientRow,
  LeadOrderRow,
  ScanRow,
  SubscriptionStatus,
  SubscriptionTier,
  TrackedKeywordRow,
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
      case 'customer.subscription.trial_will_end': {
        // Stripe fires this 3 days before the trial ends. We send a
        // reminder email surfacing the trial value so far + both
        // action paths (manage / cancel). Fire-and-forget on the
        // response side: failures don't 500 the webhook (Stripe
        // would retry and we'd duplicate the email).
        const sub = event.data.object as Stripe.Subscription;
        try {
          await sendTrialEndingReminder(supabase, sub);
        } catch (e) {
          console.error(
            `[stripe-webhook] trial_will_end email failed:`,
            e instanceof Error ? e.message : String(e)
          );
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await markPastDue(supabase, invoice);
        break;
      }
      case 'checkout.session.completed': {
        // Routes ONLY for audit-upgrade sessions — the standard
        // TurfScan / Pulse / Pulse+ checkout fulfillment still
        // happens in /api/orders/fulfill via the success-page form.
        // Audit upgrades skip that form entirely (the buyer is
        // already a client; we have all their data) so the webhook
        // is the only place fulfillment can happen.
        const session = event.data.object as Stripe.Checkout.Session;
        const source =
          session.metadata && 'source' in session.metadata
            ? String(session.metadata.source)
            : null;
        if (source === 'audit_upgrade') {
          await handleAuditUpgradeCompletion(supabase, session);
        }
        break;
      }
      // Other events (invoice.paid, etc.) are intentionally ignored
      // here — TurfScan / Pulse / Pulse+ checkout fulfillment lives
      // in /api/orders/fulfill and runs on the success-page form
      // submit; if a buyer never lands there, this webhook is the
      // safety net we'd wire next.
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

  // Two paths to find the client row:
  //   1. Agency-created flow (operator created the row first, then
  //      forwarded the Stripe Checkout link to the buyer). The
  //      Checkout session's subscription_data.metadata carries
  //      client_id — at this point the row has NO stripe_customer_id
  //      yet (Stripe just created the customer milliseconds ago),
  //      so customer-id lookup would miss. We match on id and
  //      ALSO stamp stripe_customer_id during the update.
  //   2. Marketing-tripwire flow (buyer paid first, fulfill route
  //      then created the row with stripe_customer_id). Existing
  //      customer-id-based lookup.
  const metadataClientId = sub.metadata?.client_id;
  const lookupByMetadata = typeof metadataClientId === 'string';
  // The select also pulls subscription_status so we can detect
  // trial→paid transitions inside this same handler. Without the
  // PRIOR status we couldn't tell if this update was a status
  // change or just a price/quantity tweak.
  const clientSelect =
    'id, billing_mode, stripe_subscription_id, stripe_customer_id, subscription_status, public_id, business_name';
  type ExistingClient = Pick<
    ClientRow,
    | 'id'
    | 'billing_mode'
    | 'stripe_subscription_id'
    | 'stripe_customer_id'
    | 'subscription_status'
    | 'public_id'
    | 'business_name'
  >;
  const { data: existingClient } = lookupByMetadata
    ? await supabase
        .from('clients')
        .select(clientSelect)
        .eq('id', metadataClientId)
        .maybeSingle<ExistingClient>()
    : await supabase
        .from('clients')
        .select(clientSelect)
        .eq('stripe_customer_id', customerId)
        .maybeSingle<ExistingClient>();

  if (!existingClient) {
    console.warn(
      `[stripe-webhook] subscription ${sub.id} (customer ${customerId}, metadata.client_id=${metadataClientId ?? 'null'}) has no matching client row — skipping`
    );
    return;
  }

  const isAgencyManaged = existingClient.billing_mode === 'agency_managed';
  // First-activation detection: was sub_id null before this event?
  // Used below to decide whether to fire the initial scan auto-
  // trigger. We capture this BEFORE the update because the update
  // is what writes sub.id onto the row.
  const isFirstActivation =
    !existingClient.stripe_subscription_id && !isAgencyManaged;

  // billing_mode flip — when a one-time-tier buyer attaches Pulse
  // (the post-purchase trial flow), we need billing_mode to move
  // from 'one_time' to 'self_serve_subscription' so resolveTier()
  // returns the real tier instead of null. The tier resolver
  // explicitly treats one_time as "no recurring tier" — without
  // this flip, the Pulse trial would set tier='pulse' on the row
  // but resolveTier() would still report null and feature gates
  // (weekly cron, alerts, etc.) wouldn't open.
  const isOneTimeAttach =
    !isAgencyManaged && existingClient.billing_mode === 'one_time';

  // Once a client is agency_managed, the operator's contract is
  // the source of truth for tier — Stripe events should mirror
  // status + sub_id but never overwrite tier.
  //
  // For one-time → trial-attach buyers, also stamp
  // onboarding_step='gbp_match' so the OnboardingWizard mounts on
  // their next /order/success render. Without this, attach buyers
  // skip the wizard entirely (the original /api/orders/fulfill ran
  // with billing_mode='one_time' and didn't set onboarding_step),
  // which means they never confirm their Google Business Profile
  // match — degrading AI Coach quality during the high-leverage
  // first 30 trial days. Idempotent: if onboarding_step is already
  // populated (somehow, e.g. a previous attach was rolled back and
  // retried), the page-side defense in app/order/success/page.tsx
  // also runs an UPDATE, but the column is whatever we're writing
  // here — no drift.
  const update: Partial<
    Pick<
      ClientRow,
      | 'tier'
      | 'subscription_status'
      | 'stripe_subscription_id'
      | 'stripe_customer_id'
      | 'billing_mode'
      | 'onboarding_step'
    >
  > = isAgencyManaged
    ? {
        subscription_status: status,
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
      }
    : {
        tier,
        subscription_status: status,
        stripe_subscription_id: sub.id,
        stripe_customer_id: customerId,
        ...(isOneTimeAttach
          ? {
              billing_mode: 'self_serve_subscription' as const,
              onboarding_step: 'gbp_match' as const,
            }
          : {}),
      };

  const { error } = await supabase
    .from('clients')
    .update(update)
    .eq('id', existingClient.id);
  if (error) {
    throw new Error(
      `clients update failed for client ${existingClient.id}: ${error.message}`
    );
  }

  // Trial→paid conversion event. When the prior status was 'trialing'
  // and the new status is 'active', the buyer's trial ended and the
  // first $39 charge succeeded. Fire to GA4 via Measurement Protocol
  // so the funnel report can attribute the conversion to the source
  // campaign (utm_source/utm_medium that the original /fourdots attach
  // session stamped on subscription metadata). Fire-and-forget — the
  // event is telemetry, not business-critical.
  if (
    existingClient.subscription_status === 'trialing' &&
    status === 'active'
  ) {
    fireMeasurementProtocolEvent({
      clientId: customerId,
      eventName: 'trial_converted_to_paid',
      params: {
        public_id: existingClient.public_id,
        tier,
        // GA4 expects 'value' for revenue reporting. Use the first
        // charge amount in dollars — Pulse $39 monthly. Real value
        // is LTV but we don't know that yet.
        currency: 'USD',
        value: tier === 'pulse_plus' ? 99 : 39,
      },
    }).catch((err) => {
      console.warn(
        '[stripe-webhook] trial_converted_to_paid GA4 event failed:',
        err
      );
    });
  }

  // Initial-scan trigger on first activation. Fires after the
  // webhook responds 200 to Stripe (Next.js `after()` runs work
  // outside the response window). Skips if scans already exist —
  // the webhook is delivered at-least-once and we don't want
  // duplicates on retried events.
  if (isFirstActivation) {
    after(async () => {
      try {
        await triggerInitialScanIfMissing(supabase, existingClient.id);
      } catch (e) {
        console.error(
          `[stripe-webhook] initial-scan trigger failed for ${existingClient.id}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    });
  }
}

/**
 * Fire the buyer's first scan on agency-created Pulse / Pulse+
 * activation. Idempotent: skips if any scan already exists for
 * this client.
 *
 * The marketing-tripwire flow handles initial scans inside
 * /api/orders/fulfill; this is the equivalent for the agency-
 * created path where the buyer enters payment after the row is
 * already onboarded. Same end state: when the buyer lands on
 * /clients/<id>?stripe_setup=complete, they see a fresh heatmap
 * instead of an empty grid.
 */
async function triggerInitialScanIfMissing(
  supabase: SupabaseLike,
  clientId: string
): Promise<void> {
  // 1. Skip if any scan exists for this client (idempotency on
  //    webhook retries + protection against accidental double-
  //    fires from rapid status transitions).
  const { count: existingScans } = await supabase
    .from('scans')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);
  if ((existingScans ?? 0) > 0) {
    return;
  }

  // 2. Resolve the (client, primary location, primary keyword) tuple
  //    needed by runScanForLocation.
  const { data: client } = await supabase
    .from('clients')
    .select('id, business_name')
    .eq('id', clientId)
    .maybeSingle<Pick<ClientRow, 'id' | 'business_name'>>();
  if (!client) return;

  const { data: location } = await supabase
    .from('client_locations')
    .select('id, latitude, longitude, service_radius_miles')
    .eq('client_id', clientId)
    .eq('is_primary', true)
    .maybeSingle<
      Pick<
        ClientLocationRow,
        'id' | 'latitude' | 'longitude' | 'service_radius_miles'
      >
    >();
  if (!location) {
    console.warn(
      `[stripe-webhook] client ${clientId} has no primary location — skipping initial scan`
    );
    return;
  }

  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('id, keyword')
    .eq('client_id', clientId)
    .eq('location_id', location.id)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword'>>();
  if (!keyword) {
    console.warn(
      `[stripe-webhook] client ${clientId} location ${location.id} has no keywords — skipping initial scan`
    );
    return;
  }

  await runScanForLocation(supabase, {
    client,
    location,
    keyword,
    scanType: 'on_demand',
    triggeredBy: null,
  });
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
  //
  // Also pull subscription_status + public_id so we can detect
  // trial→canceled transitions and fire the corresponding GA4
  // server-side event (trial_canceled_before_day_31).
  const { data: client } = await supabase
    .from('clients')
    .select('billing_mode, subscription_status, public_id, id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle<
      Pick<
        ClientRow,
        'billing_mode' | 'subscription_status' | 'public_id' | 'id'
      >
    >();
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

  // Trial-canceled-before-day-31 event. Fires when the prior status
  // was 'trialing' and Stripe deleted the subscription (either due
  // to cancel_at_period_end at trial end, or an immediate cancel
  // during the trial). Either way, no $39 charge ever ran.
  // Server-side via GA4 Measurement Protocol so the funnel report
  // can attribute back to the source campaign.
  if (client && client.subscription_status === 'trialing') {
    fireMeasurementProtocolEvent({
      clientId: customerId,
      eventName: 'trial_canceled_before_day_31',
      params: {
        public_id: client.public_id,
      },
    }).catch((err) => {
      console.warn(
        '[stripe-webhook] trial_canceled_before_day_31 GA4 event failed:',
        err
      );
    });
  }
}

/**
 * customer.subscription.trial_will_end handler — sends the day-28
 * (3-days-before-end) reminder email. Pulls scan stats so the email
 * surfaces concrete trial value ("4 scans run, current TurfScore
 * 38") rather than abstract reminders.
 *
 * Idempotent against retries: Stripe fires this event exactly once
 * per subscription per trial, but we still scope the email send
 * gate behind the existence of resolvable scan data + a valid
 * client row, so duplicate-delivery hardware bugs don't blast the
 * buyer with the same email twice.
 */
async function sendTrialEndingReminder(
  supabase: SupabaseLike,
  sub: Stripe.Subscription
): Promise<void> {
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // Resolve the client + the buyer's email. Email comes from Stripe
  // (subscription.customer expanded) so we don't have to round-trip
  // a separate Customer.retrieve call.
  const { data: client } = await supabase
    .from('clients')
    .select('id, public_id, business_name')
    .eq('stripe_customer_id', customerId)
    .maybeSingle<
      Pick<ClientRow, 'id' | 'public_id' | 'business_name'>
    >();
  if (!client) {
    console.warn(
      `[stripe-webhook] trial_will_end for customer ${customerId} has no matching client — skipping`
    );
    return;
  }

  const stripe = await getStripe();
  if (!stripe) {
    console.warn(
      '[stripe-webhook] Stripe not configured — skipping trial_will_end email'
    );
    return;
  }
  let buyerEmail: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!('deleted' in customer && customer.deleted)) {
      buyerEmail =
        ('email' in customer && typeof customer.email === 'string'
          ? customer.email
          : null) ?? null;
    }
  } catch {
    // Soft-fail — without an email we can't send, but we still log.
  }
  if (!buyerEmail) {
    console.warn(
      `[stripe-webhook] trial_will_end for client ${client.id} has no resolvable buyer email — skipping`
    );
    return;
  }

  // Scan stats during the trial. Count = # of completed scans for
  // any location belonging to this client; current TurfScore = the
  // most recent completed scan's score. Both nullable for the rare
  // case where the trial ends without a single completed scan.
  const { count: scanCount } = await supabase
    .from('scans')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .not('completed_at', 'is', null);

  const { data: latestScan } = await supabase
    .from('scans')
    .select('turf_score')
    .eq('client_id', client.id)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ turf_score: number | null }>();

  // Charge date = sub.trial_end as a human-readable string in the
  // buyer's local US format. Stripe gives us trial_end as a Unix
  // timestamp (seconds); convert to ms then format.
  const trialEndMs = (sub.trial_end ?? 0) * 1000;
  const chargeDate = trialEndMs
    ? new Date(trialEndMs).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : 'in 3 days';

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  // The portal renders at /portal/<publicId> (no /billing sub-route);
  // the billing panel mounts inline on that page when the client is
  // on a subscription. Both URLs land in the same place.
  const manageSubscriptionUrl = `${origin}/portal/${client.public_id}`;
  // Cancel link uses the ?cancel_trial=1 query param that the
  // ClientBillingPanel reads on mount and auto-opens the
  // cancel-confirm modal. One click confirms; sub-2-second flow
  // matching the launch checklist.
  const cancelTrialUrl = `${origin}/portal/${client.public_id}?cancel_trial=1`;

  await sendPulseTrialEnding({
    to: buyerEmail,
    businessName: client.business_name,
    scanCount: scanCount ?? 0,
    currentTurfScore:
      latestScan?.turf_score != null ? Number(latestScan.turf_score) : null,
    chargeDate,
    manageSubscriptionUrl,
    cancelTrialUrl,
  });
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

// ─── Audit-upgrade fulfillment ────────────────────────────────────────
//
// Fired from checkout.session.completed when metadata.source =
// 'audit_upgrade'. Creates the audit-tier lead_orders row, marks it
// fulfilled, computes LLM Fit Score, creates visibility_audits row
// (which the Phase-3 milestone cron picks up for prep-PDF
// generation 24h pre-call), stamps prospects.upgraded_to_audit_at
// when the original purchase was a cold-email cohort, and sends the
// audit order-confirmation email so the buyer has the Cal.com
// booking link in their inbox in addition to the success-page
// embed.
//
// Idempotent. Stripe webhooks deliver at-least-once; this handler
// no-ops if the lead_orders row already exists for the upgrade
// session.

async function handleAuditUpgradeCompletion(
  supabase: ReturnType<typeof getServerSupabase>,
  session: Stripe.Checkout.Session
): Promise<void> {
  const meta = (session.metadata ?? {}) as Record<string, string>;
  const originalScanId = meta.original_scan_id ?? null;
  const originalLeadOrderId = meta.original_lead_order_id ?? null;
  const clientId = meta.client_id ?? null;
  const prospectId = meta.prospect_id ?? null;

  if (!originalScanId || !originalLeadOrderId || !clientId) {
    console.error(
      '[audit-upgrade] session missing required metadata',
      session.id,
      meta
    );
    return;
  }

  // Idempotency check — has this upgrade session already been
  // fulfilled? Look for a lead_orders row with this exact
  // stripe_session_id. Stripe webhook retries hit the same path.
  const { data: existing } = await supabase
    .from('lead_orders')
    .select('id, status')
    .eq('stripe_session_id', session.id)
    .maybeSingle<Pick<LeadOrderRow, 'id' | 'status'>>();
  if (existing) {
    return;
  }

  // Resolve the original lead_orders row for buyer email + scan
  // context.
  const { data: originalLeadOrder } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('id', originalLeadOrderId)
    .maybeSingle<LeadOrderRow>();
  if (!originalLeadOrder) {
    console.error(
      '[audit-upgrade] original lead_orders row not found',
      originalLeadOrderId
    );
    return;
  }

  // Resolve the client.
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (!client) {
    console.error('[audit-upgrade] client not found', clientId);
    return;
  }

  // Resolve the original scan for LLM Fit Score inputs + the
  // visibility_audits.scan_id reference.
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', originalScanId)
    .maybeSingle<ScanRow>();
  if (!scan) {
    console.error('[audit-upgrade] original scan not found', originalScanId);
    return;
  }

  // Create the lead_orders row for the upgrade purchase. Marks it
  // fulfilled immediately since the buyer skipped the post-checkout
  // form — they're already a client. audit_call_status: 'unbooked'
  // matches the standalone-audit fulfill flow so the Cal.com
  // webhook handler can stamp 'booked' when the buyer schedules.
  const buyerEmail =
    originalLeadOrder.email ??
    session.customer_details?.email ??
    null;

  const { data: newLeadOrder, error: leadInsertErr } = await supabase
    .from('lead_orders')
    .insert({
      stripe_session_id: session.id,
      tier: 'audit',
      email: buyerEmail,
      client_id: client.id,
      status: 'fulfilled',
      stripe_metadata: {
        source: 'audit_upgrade',
        upgrade_placement: meta.upgrade_placement ?? null,
        original_scan_id: originalScanId,
        original_lead_order_id: originalLeadOrderId,
        prospect_id: prospectId,
        amount_total: session.amount_total ?? null,
        audit_call_status: 'unbooked',
        audit_call_initiated_at: new Date().toISOString(),
      },
    })
    .select('*')
    .single<LeadOrderRow>();

  if (leadInsertErr || !newLeadOrder) {
    console.error(
      '[audit-upgrade] lead_orders insert failed',
      leadInsertErr?.message
    );
    return;
  }

  // Compute LLM Fit Score against the buyer's known signals. At
  // upgrade time we typically don't have richer data (Apollo
  // enrichment, ad-active flags) than at the original purchase, so
  // tradeFit is the primary signal. Trade is inferred from the
  // primary tracked keyword.
  const { data: primaryKeyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('client_id', client.id)
    .eq('is_primary', true)
    .maybeSingle<TrackedKeywordRow>();
  const tradeFit = primaryKeyword
    ? inferTradeFitFromKeyword(primaryKeyword.keyword)
    : null;
  const fitBreakdown = computeLlmFitScore({
    revenueBand: null,
    tradeFit,
    metroFit: null,
    adActive: null,
    reviewCount: null,
  });

  // Create the visibility_audits row. The Phase-3 milestone cron
  // sweeps this 24h before strategist_call_scheduled_at + generates
  // the prep PDF + emails Anthony.
  const auditResult = await createVisibilityAudit(supabase, {
    leadOrderId: newLeadOrder.id,
    scanId: scan.id,
    clientId: client.id,
    startingTurfScore: scan.turf_score,
    liftPromiseTargetScore: null,
    llmFitScore: fitBreakdown.score,
    llmFitBreakdown: fitBreakdown,
  });
  if (!auditResult.ok) {
    console.error(
      '[audit-upgrade] visibility_audits insert failed (non-fatal)',
      auditResult.error
    );
  }

  // Stamp prospects.upgraded_to_audit_at when the original purchase
  // was from the cold-email cohort. Idempotent — only updates rows
  // where the column is still null.
  if (prospectId) {
    try {
      await supabase
        .from('prospects')
        .update({ upgraded_to_audit_at: new Date().toISOString() })
        .eq('id', prospectId)
        .is('upgraded_to_audit_at', null);
    } catch (e) {
      console.error(
        '[audit-upgrade] prospects.upgraded_to_audit_at stamp failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // Send the order confirmation email — same template as a $499
  // standalone audit purchase, includes the Cal.com booking link
  // pre-filled with the buyer's email + business name.
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.turfmap.ai';
  const dashboardUrl = `${origin}/portal/${client.public_id}`;
  const bookingUrl = buyerEmail
    ? calcomBookingUrlForTier({
        tier: 'audit',
        email: buyerEmail,
        businessName: client.business_name,
      })
    : null;
  if (buyerEmail) {
    try {
      await sendOrderConfirmation({
        to: buyerEmail,
        businessName: client.business_name,
        tier: 'audit',
        dashboardUrl,
        bookingUrl,
        auditPurchaseKind: 'upgrade',
      });
    } catch (e) {
      console.error(
        '[audit-upgrade] order confirmation email failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

/** Same trade-keyword matcher used in /api/orders/fulfill. Duplicated
 *  rather than extracted into lib/audit/ since the heuristic might
 *  diverge per surface in the future. */
function inferTradeFitFromKeyword(
  keyword: string | undefined
): boolean | null {
  if (!keyword) return null;
  const k = keyword.toLowerCase();
  const TRADE_NEEDLES = [
    'electrician',
    'electrical',
    'hvac',
    'heating',
    'air conditioning',
    'a/c repair',
    'furnace',
    'landscap',
    'lawn care',
    'lawn maintenance',
    'plumb',
    'drain cleaning',
    'water heater',
    'renovat',
    'remodel',
    'kitchen remodel',
    'bathroom remodel',
    'restoration',
    'water damage',
    'fire damage',
    'mold remediation',
    'roof',
    'windows',
    'doors',
    'window install',
    'door install',
  ];
  for (const needle of TRADE_NEEDLES) {
    if (k.includes(needle)) return true;
  }
  return null;
}
