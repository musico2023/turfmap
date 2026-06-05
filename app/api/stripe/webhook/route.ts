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
import {
  sendPulseTrialEnding,
  sendOrderConfirmation,
  sendScanRecovery,
} from '@/lib/email/resend';
import { fireMeasurementProtocolEvent } from '@/lib/analytics/measurementProtocol';
import { computeLlmFitScore } from '@/lib/audit/llmFitScore';
import { inferTradeFitFromKeyword } from '@/lib/audit/tradeClassifier';
import { portalUrl } from '@/lib/urls';
import { createVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { calcomBookingUrlForTier } from '@/lib/integrations/calcom';
import { ensurePulsePlusCommitmentSchedule } from '@/lib/stripe/subscription';
import { handleScoreUnlockCompletion } from '@/lib/score/handleScoreUnlock';
import {
  sendMetaCapiEvent,
  buildFbcFromFbclid,
} from '@/lib/marketing/metaCapi';
import { randomUUID } from 'crypto';
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
        // Wrap Pulse+ monthly subscriptions in a 3-month commitment
        // Subscription Schedule. Idempotent — re-firing on .updated
        // events no-ops once the schedule exists, which is also why
        // we attach the helper to BOTH .created and .updated (a
        // subscription that gets repaired post-creation should still
        // pick up its schedule on the next sync). Fail-soft: log and
        // continue if it errors — Stripe retries the whole webhook
        // anyway, and the cancellation gate downstream is the real
        // commitment enforcement.
        try {
          const wrap = await ensurePulsePlusCommitmentSchedule(sub);
          if (!wrap.ok) {
            console.warn(
              `[stripe-webhook] Pulse+ commitment schedule wrap failed for ${sub.id}: ${wrap.message}`
            );
          }
        } catch (e) {
          console.warn(
            `[stripe-webhook] Pulse+ commitment schedule wrap threw for ${sub.id}:`,
            e instanceof Error ? e.message : String(e)
          );
        }
        // Pulse trial subscription created — cancel the Pulse-recovery
        // drip for this client so we don't keep nudging them to do the
        // thing they just did. Only fires on .created (the first time
        // the subscription exists); .updated would re-trigger noisy
        // (and idempotent-but-pointless) cancellations on every status
        // tick. attach_source is stamped by pulse-attach on
        // subscription_data.metadata; absence means this wasn't a
        // pulse-attach origin (could be a self-serve subscribe, agency-
        // managed, etc.) and there's no recovery drip to cancel.
        if (event.type === 'customer.subscription.created') {
          const attachSource = sub.metadata?.attach_source;
          const subClientId = sub.metadata?.client_id;
          if (attachSource === 'order_success' && subClientId) {
            try {
              const { cancelUpsellRecoveryEmails } = await import(
                '@/lib/score/cancelUpsellRecoveryEmails'
              );
              await cancelUpsellRecoveryEmails(
                supabase,
                subClientId,
                'pulse'
              );
            } catch (e) {
              console.warn(
                `[stripe-webhook] cancelUpsellRecoveryEmails(pulse) threw for ${sub.id}:`,
                e instanceof Error ? e.message : String(e)
              );
            }
          }
        }
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
          // Cancel the audit-recovery drip for this client — the
          // buyer just converted via the Stripe Checkout redirect
          // path. Same cancellation that /api/upgrade/audit/confirm
          // fires for the 1-click inline path. Lookup by client_id
          // pulled off the session metadata (handleAuditUpgrade-
          // Completion is the authority on which client_id this
          // session belongs to; metadata.client_id is set at
          // create-session time but may be missing when the buyer
          // upgrades pre-intake — that path has no audit-recovery
          // drip to cancel anyway since the score_unlock client row
          // exists by then).
          const auditClientId =
            session.metadata && 'client_id' in session.metadata
              ? String(session.metadata.client_id ?? '')
              : '';
          if (auditClientId) {
            try {
              const { cancelUpsellRecoveryEmails } = await import(
                '@/lib/score/cancelUpsellRecoveryEmails'
              );
              await cancelUpsellRecoveryEmails(
                supabase,
                auditClientId,
                'audit'
              );
            } catch (e) {
              console.warn(
                `[stripe-webhook] cancelUpsellRecoveryEmails(audit) threw for ${session.id}:`,
                e instanceof Error ? e.message : String(e)
              );
            }
          }
        } else if (source === 'score_unlock') {
          // /score lead-magnet → $99 unlock. Flips client.is_preview=false,
          // generates AI Coach in after(), provisions portal access, sends
          // confirmation emails, inserts lead_orders row, fires operator
          // Slack ping. The buyer's browser is concurrently redirecting
          // to /order/success, which auto-fulfills against the same
          // session — both paths are idempotent so whichever runs first
          // wins and the other no-ops.
          await handleScoreUnlockCompletion(supabase, session);
        }
        break;
      }
      case 'checkout.session.expired': {
        // Cart-abandonment recovery. Fired when a scan-funnel Checkout
        // session passes its 60-min expires_at unpaid (see
        // /api/scan/checkout/init). Scoped to source='scan_intake' so
        // only the funnel that opts into the 60-min TTL gets recovery
        // emails. `expired` and `completed` are mutually exclusive for a
        // session, so a buyer who paid can never land here.
        const session = event.data.object as Stripe.Checkout.Session;
        const source =
          session.metadata && 'source' in session.metadata
            ? String(session.metadata.source)
            : null;
        if (source === 'scan_intake') {
          await handleAbandonedCheckout(supabase, session);
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
  const manageSubscriptionUrl = portalUrl(origin, client.public_id);
  // Cancel link uses the ?cancel_trial=1 query param that the
  // ClientBillingPanel reads on mount and auto-opens the
  // cancel-confirm modal. One click confirms; sub-2-second flow
  // matching the launch checklist.
  const cancelTrialUrl = `${portalUrl(origin, client.public_id)}?cancel_trial=1`;

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
  const pendingClientSessionId = meta.pending_client_session_id ?? null;
  const prospectId = meta.prospect_id ?? null;

  // original_lead_order_id is always required (this is the source-of-
  // truth link back to the original TurfScan purchase). The buyer
  // identity can come from EITHER:
  //   (a) client_id — buyer already submitted intake before upgrading
  //   (b) pending_client_session_id — buyer upgraded BEFORE intake;
  //       /api/orders/fulfill will sweep this row and link client_id
  //       when intake completes.
  if (!originalLeadOrderId || (!clientId && !pendingClientSessionId)) {
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

  // Resolve the client. Optional — when null (buyer upgraded BEFORE
  // submitting intake), we create the lead_orders row with
  // client_id=null and status='pending' so /api/orders/fulfill can
  // sweep + link it after the buyer fills intake.
  //
  // Race-condition handling: if this webhook fires AFTER the buyer
  // has already submitted intake (rare but possible — Stripe webhook
  // delivery isn't instant), originalLeadOrder.client_id may now be
  // populated even though our session metadata said pending. Use
  // whichever client_id is available so we don't leave the row
  // perpetually pending.
  let effectiveClientId: string | null =
    clientId ?? originalLeadOrder.client_id ?? null;
  let client: ClientRow | null = null;
  if (effectiveClientId) {
    const { data: c } = await supabase
      .from('clients')
      .select('*')
      .eq('id', effectiveClientId)
      .maybeSingle<ClientRow>();
    if (!c) {
      console.error('[audit-upgrade] client not found', effectiveClientId);
      // Fall through to pending path rather than fail; the sweep can
      // try again when intake re-fires fulfill.
      effectiveClientId = null;
    } else {
      client = c;
    }
  }

  // Resolve the original scan for LLM Fit Score inputs + the
  // visibility_audits.scan_id reference. Optional in the pending-
  // intake case (the scan is created alongside the client during
  // intake fulfillment). When the race-condition recovery above
  // resolved a client even though session metadata didn't pass
  // originalScanId, look up the scan by client_id instead.
  let scan: ScanRow | null = null;
  if (originalScanId) {
    const { data: s } = await supabase
      .from('scans')
      .select('*')
      .eq('id', originalScanId)
      .maybeSingle<ScanRow>();
    if (!s) {
      console.error('[audit-upgrade] original scan not found', originalScanId);
      return;
    }
    scan = s;
  } else if (client) {
    const { data: s } = await supabase
      .from('scans')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ScanRow>();
    scan = s ?? null;
  }

  // Create the lead_orders row for the upgrade purchase.
  //
  // When client is present (the typical post-intake upgrade path),
  // we mark this row 'fulfilled' immediately + create
  // visibility_audits inline. When client is null (pre-intake
  // upgrade), we keep status='pending' so /api/orders/fulfill can
  // recognize it as a sweep candidate when intake completes; the
  // visibility_audits row is also deferred since its NOT NULL
  // constraints on client_id + scan_id can't be satisfied yet.
  const isPendingIntake = client === null;
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
      client_id: client?.id ?? null,
      status: isPendingIntake ? 'pending' : 'fulfilled',
      stripe_metadata: {
        source: 'audit_upgrade',
        upgrade_placement: meta.upgrade_placement ?? null,
        original_scan_id: originalScanId,
        original_lead_order_id: originalLeadOrderId,
        // Preserve the pending-intake link so /api/orders/fulfill
        // can find this row by scanning lead_orders WHERE
        // stripe_metadata.pending_client_session_id = <scan session>.
        pending_client_session_id: pendingClientSessionId,
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

  // In the pending-intake path, stop here. The remaining work
  // (visibility_audits creation, LLM fit score, prospects stamp,
  // email send) happens in /api/orders/fulfill when the buyer
  // submits intake.
  if (isPendingIntake || !client || !scan) {
    console.log(
      '[audit-upgrade] deferred to intake-fulfillment sweep',
      newLeadOrder.id
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
  const dashboardUrl = portalUrl(origin, client.public_id);
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

  // Meta CAPI Purchase event — server-side firing so ad-blockers can't
  // suppress the conversion. event_id is stamped on the ORIGINAL scan
  // lead_orders row (where /order/success looks it up) so the
  // client-side fbq fired by isAuditUpgrade renders the matched pair
  // and Meta counts ONE conversion. Without dedup we'd see 2 events
  // per real conversion in Events Manager.
  try {
    const metaEventId = randomUUID();
    const originalMeta = originalLeadOrder.stripe_metadata as
      | Record<string, unknown>
      | null;
    const fbclid =
      originalMeta && typeof originalMeta.attribution_fbclid === 'string'
        ? originalMeta.attribution_fbclid
        : null;
    const leadSource =
      originalMeta && typeof originalMeta.lead_source === 'string'
        ? originalMeta.lead_source
        : null;
    const fbc = fbclid ? buildFbcFromFbclid(fbclid) : null;

    const customData: Record<string, string | number | boolean> = {
      content_name: 'Visibility Audit',
      content_category: 'upgrade',
      value: 197,
      currency: 'USD',
    };
    if (leadSource) customData.lead_source = leadSource;

    const capiResult = await sendMetaCapiEvent({
      event: 'Purchase',
      eventId: metaEventId,
      eventSourceUrl: `${origin}/order/success?session_id=${originalLeadOrder.stripe_session_id ?? ''}&upgrade=audit`,
      userData: {
        email: buyerEmail ?? undefined,
        fbc,
      },
      customData,
    });

    // Stamp event_id on the ORIGINAL scan row so /order/success?
    // upgrade=audit can read it and pass to MetaPixelTrack for the
    // client-side dedup. Also tag the audit_upgrade lead_orders row
    // so analytics can confirm the CAPI side fired (vs. only
    // client-side).
    if (originalLeadOrder.id) {
      await supabase
        .from('lead_orders')
        .update({
          stripe_metadata: {
            ...(originalMeta ?? {}),
            meta_audit_purchase_event_id: metaEventId,
            meta_audit_purchase_value_cents: '19700',
            meta_audit_purchase_capi_fired: capiResult.ok ? 'true' : 'false',
          },
        })
        .eq('id', originalLeadOrder.id);
    }
    if (!capiResult.ok && capiResult.reason !== 'not_configured') {
      console.warn(
        '[audit-upgrade] Meta CAPI Purchase failed:',
        capiResult.reason,
        capiResult.message
      );
    }
  } catch (e) {
    console.warn(
      '[audit-upgrade] Meta CAPI Purchase threw',
      e instanceof Error ? e.message : String(e)
    );
  }
}

// ─── Cart-abandonment recovery ────────────────────────────────────────
//
// Fired from checkout.session.expired when metadata.source =
// 'scan_intake'. Sends a 3-touch recovery sequence to a buyer who
// reached Stripe Checkout but never paid (the 60-min session expired):
//
//   touch 1 — immediate (this handler)
//   touch 2 — +24h, queued via Resend scheduled-send
//   touch 3 — +72h, queued via Resend scheduled-send
//
// The CTA in every touch is a resume link back to /intake with the
// buyer's business name + keyword prefilled (Stripe sessions are
// single-use, so we route them through a fresh pre-filled intake rather
// than the dead expired session).
//
// Idempotency: an abandoned_checkouts row keyed UNIQUE on
// stripe_session_id. We insert first; if the row already exists (Stripe
// re-delivered the event) the insert no-ops and we return without
// re-sending. The scheduled touch IDs are persisted so
// /api/orders/fulfill can cancel them if the buyer later recovers.

const RECOVERY_TOUCH_2_DELAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TOUCH_3_DELAY_MS = 72 * 60 * 60 * 1000;

async function handleAbandonedCheckout(
  supabase: ReturnType<typeof getServerSupabase>,
  session: Stripe.Checkout.Session
): Promise<void> {
  const meta = (session.metadata ?? {}) as Record<string, string>;

  // Buyer email: prefer the stamped intake_email, fall back to the
  // session's customer_details (Stripe captures it on the hosted page
  // even for abandoned sessions once the buyer typed it).
  const email =
    meta.intake_email?.trim() ||
    session.customer_details?.email?.trim() ||
    session.customer_email?.trim() ||
    null;
  if (!email) {
    // No address to recover to — nothing actionable. Not an error.
    console.warn(
      '[cart-recovery] expired scan_intake session has no email',
      session.id
    );
    return;
  }

  const businessName = meta.business_name?.trim() || null;
  const keyword = meta.keyword?.trim() || null;
  const tier = meta.tier?.trim() || 'scan';

  // Idempotency gate: insert the row first. The UNIQUE constraint on
  // stripe_session_id means a Stripe re-delivery hits onConflict and we
  // bail before sending a second sequence. We check the returned row:
  // when the insert was a no-op (already existed), `inserted` is empty.
  const { data: inserted, error: insertErr } = await supabase
    .from('abandoned_checkouts')
    .upsert(
      {
        stripe_session_id: session.id,
        email,
        business_name: businessName,
        keyword,
        tier,
      },
      { onConflict: 'stripe_session_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle<{ id: string }>();

  if (insertErr) {
    // Surface as a 500 so Stripe retries — the insert is the
    // idempotency anchor, so we must not send emails if we couldn't
    // record the row (a retry would otherwise double-send).
    throw new Error(`abandoned_checkouts insert failed: ${insertErr.message}`);
  }
  if (!inserted) {
    // Row already existed — this is a duplicate delivery. Sequence
    // already sent/queued. No-op.
    return;
  }

  // Build the prefilled resume URL → /intake. We deliberately route
  // through a fresh intake (not the expired Stripe session, which is
  // single-use) with the buyer's details in the query string so the
  // form lands pre-filled. Carry attribution through so a recovered
  // purchase is still attributed to the original campaign.
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const resumeUrl = (() => {
    const u = new URL(`${origin}/intake`);
    u.searchParams.set('tier', tier);
    u.searchParams.set('utm_source', 'cart_recovery');
    u.searchParams.set('utm_medium', 'email');
    if (businessName) u.searchParams.set('prefill_business', businessName);
    if (keyword) u.searchParams.set('prefill_keyword', keyword);
    if (meta.coupon) u.searchParams.set('coupon', meta.coupon);
    if (meta.prospect_id) u.searchParams.set('prospect_id', meta.prospect_id);
    return u.toString();
  })();

  // Touch 1 — immediate.
  try {
    await sendScanRecovery({
      to: email,
      businessName,
      keyword,
      resumeUrl,
      stage: 'touch_1',
    });
  } catch (e) {
    // Non-fatal: the row is recorded, the scheduled touches below are
    // the more valuable recovery shots, and we don't want to 500 (which
    // would make Stripe retry and — since the row now exists — skip the
    // whole sequence on the retry).
    console.error(
      '[cart-recovery] touch_1 send failed (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }

  // Touches 2 & 3 — queued via Resend scheduled-send. Persist the
  // returned IDs so /api/orders/fulfill can cancel them on recovery.
  const now = Date.now();
  let touch2Id: string | null = null;
  let touch3Id: string | null = null;
  try {
    const r2 = await sendScanRecovery({
      to: email,
      businessName,
      keyword,
      resumeUrl,
      stage: 'touch_2',
      scheduledAt: new Date(now + RECOVERY_TOUCH_2_DELAY_MS).toISOString(),
    });
    touch2Id = r2.id ?? null;
  } catch (e) {
    console.error(
      '[cart-recovery] touch_2 schedule failed (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }
  try {
    const r3 = await sendScanRecovery({
      to: email,
      businessName,
      keyword,
      resumeUrl,
      stage: 'touch_3',
      scheduledAt: new Date(now + RECOVERY_TOUCH_3_DELAY_MS).toISOString(),
    });
    touch3Id = r3.id ?? null;
  } catch (e) {
    console.error(
      '[cart-recovery] touch_3 schedule failed (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }

  if (touch2Id || touch3Id) {
    const { error: updateErr } = await supabase
      .from('abandoned_checkouts')
      .update({ touch_2_email_id: touch2Id, touch_3_email_id: touch3Id })
      .eq('stripe_session_id', session.id);
    if (updateErr) {
      // Non-fatal: the emails are queued regardless; we just lose the
      // ability to cancel them on recovery. Log so it's visible.
      console.error(
        '[cart-recovery] failed to persist scheduled touch IDs',
        updateErr.message
      );
    }
  }
}

