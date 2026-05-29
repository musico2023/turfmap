/**
 * POST /api/upgrade/audit/confirm
 *
 * Inline 1-click audit upgrade. Charges $197 against the buyer's
 * saved payment method (the card they used on the original scan
 * purchase, retained via customer_creation='always' +
 * payment_intent_data.setup_future_usage='off_session' on the
 * scan checkout). No Stripe Checkout redirect — payment confirms
 * server-side off_session in a single round trip.
 *
 * Companion to /api/upgrade/audit/create-session, which remains the
 * fallback for buyers without a saved payment method (legacy
 * 'if_required' purchases) and for 3DS-required cards.
 *
 * Flow:
 *   1. Validate scan session + look up client/customer (same gates
 *      as create-session: 24h window, not already upgraded, etc.)
 *   2. Resolve the customer's default payment method (most recent
 *      attached card).
 *   3. If no saved card → return { fallback_to_checkout: true }.
 *      Frontend redirects to /api/upgrade/audit/create-session.
 *   4. Create + confirm a PaymentIntent($197, off_session, confirm).
 *   5. On success: synchronously run audit fulfillment (lead_orders
 *      insert, visibility_audits, prospects stamp).
 *   6. On requires_action (3DS) → return { fallback_to_checkout: true,
 *      reason: 'authentication_required' }. Frontend redirects to
 *      Checkout so Stripe can handle the 3DS challenge.
 *   7. On hard failure → return error.
 *
 * Pricing: $197 net, hardcoded (the $499→$197 marketing math is
 * client-facing only; Stripe charges the net amount directly).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type Stripe from 'stripe';
import { getStripe, STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';
import { loadCheckoutSession } from '@/lib/stripe/session';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow, LeadOrderRow, ScanRow } from '@/lib/supabase/types';
import { createVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { computeLlmFitScore } from '@/lib/audit/llmFitScore';
import { notifyAuditUpgradePurchase } from '@/lib/audit/operatorSlack';
import { agencyClientUrl } from '@/lib/urls';

export const runtime = 'nodejs';
export const maxDuration = 30;

const UPGRADE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Net audit-upgrade price in cents. The $499 → $197 (-$302) framing
// is buyer-facing copy only; the actual charge is $197.
const UPGRADE_PRICE_CENTS = 19700;
const UPGRADE_PRICE_CURRENCY = 'usd';

const RequestBody = z.object({
  source: z.literal('order_success'),
  session_id: z.string(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof RequestBody>;
  try {
    body = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: `invalid request body: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
  }

  // ─── 1. Resolve session + customer + client (same gates as create-session) ─
  const sessionResult = await loadCheckoutSession(body.session_id);
  if ('kind' in sessionResult) {
    return NextResponse.json(
      { error: `session validation failed: ${sessionResult.kind}` },
      { status: 400 }
    );
  }
  if (sessionResult.tier !== 'scan') {
    return NextResponse.json(
      { error: 'upgrade only available for TurfScan purchases' },
      { status: 400 }
    );
  }
  // Free-scan gate (mirrors create-session step 1.5). The $302
  // UPGRADE_302_CREDIT exists to count the original scan price toward
  // the $499 audit. Buyers who paid $0 (VIP /freescan, future 100%-off
  // codes) have no scan price to credit — refuse the discounted upgrade.
  // (COLDSCAN /yourmap orders can't reach this route at all — they
  // have no Stripe session, and this route loads by session_id.)
  if (sessionResult.amountTotal === 0) {
    return NextResponse.json(
      {
        error:
          'The discounted audit upgrade is only available for buyers who paid for their original TurfScan. The $302 credit applies your scan price toward the audit — this order was $0.',
        original_amount_cents: sessionResult.amountTotal,
      },
      { status: 403 }
    );
  }
  const customerId = sessionResult.customerId;
  const prospectIdFromMetadata = sessionResult.prospectId;

  if (!customerId) {
    // No customer attached → no saved payment method possible.
    // Fall back to the Stripe Checkout flow.
    return NextResponse.json({
      fallback_to_checkout: true,
      reason: 'no_customer',
    });
  }

  const { data: leadOrder } = await supabase
    .from('lead_orders')
    .select('*')
    .eq('stripe_session_id', body.session_id)
    .maybeSingle<LeadOrderRow>();
  if (!leadOrder) {
    return NextResponse.json(
      { error: 'no lead_orders row for this session' },
      { status: 400 }
    );
  }

  let client: ClientRow | null = null;
  if (leadOrder.client_id) {
    const { data: c } = await supabase
      .from('clients')
      .select('*')
      .eq('id', leadOrder.client_id)
      .maybeSingle<ClientRow>();
    client = c;
  }

  // ─── 2. 24h window check ───────────────────────────────────────────
  const orderAge = Date.now() - new Date(leadOrder.created_at).getTime();
  if (orderAge > UPGRADE_WINDOW_MS) {
    return NextResponse.json(
      {
        error: 'upgrade window expired',
        order_created_at: leadOrder.created_at,
      },
      { status: 410 }
    );
  }

  // ─── 3. Already-upgraded check (only meaningful when client exists) ─
  if (client) {
    const { data: existingAudit } = await supabase
      .from('visibility_audits')
      .select('id')
      .eq('client_id', client.id)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (existingAudit) {
      return NextResponse.json(
        { error: 'this client has already upgraded to audit' },
        { status: 400 }
      );
    }
  }

  // Idempotency: if a previous confirm() succeeded but the response
  // was dropped on the wire, the buyer would retry. Catch via the
  // metadata.original_scan_session lookup — only one audit upgrade
  // per scan session.
  const { data: existingUpgrade } = await supabase
    .from('lead_orders')
    .select('id, status')
    .eq('tier', 'audit')
    .filter(
      'stripe_metadata->>source',
      'eq',
      'audit_upgrade'
    )
    .filter(
      'stripe_metadata->>original_lead_order_id',
      'eq',
      leadOrder.id
    )
    .maybeSingle<{ id: string; status: string }>();
  if (existingUpgrade) {
    return NextResponse.json({
      ok: true,
      already_processed: true,
      lead_order_id: existingUpgrade.id,
    });
  }

  // ─── 4. Resolve customer's default payment method ──────────────────
  // List card payment methods on this customer. We want the most
  // recently attached card (the one used on the scan purchase, kept
  // via setup_future_usage='off_session').
  let paymentMethod: Stripe.PaymentMethod | null = null;
  try {
    const pmList = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 5,
    });
    paymentMethod = pmList.data[0] ?? null;
  } catch (e) {
    console.error(
      '[upgrade/confirm] paymentMethods.list failed',
      e instanceof Error ? e.message : String(e)
    );
  }
  if (!paymentMethod) {
    return NextResponse.json({
      fallback_to_checkout: true,
      reason: 'no_saved_payment_method',
    });
  }

  // ─── 5. Resolve original scan (for visibility_audits) if client exists ─
  let originalScan: ScanRow | null = null;
  if (client) {
    const { data: s } = await supabase
      .from('scans')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ScanRow>();
    originalScan = s ?? null;
  }

  // ─── 6. Create + confirm PaymentIntent ─────────────────────────────
  // off_session=true: the buyer initiated this (clicking the
  // confirm button) but isn't actively involved in the payment
  // confirmation UI. Stripe handles SCA exemptions accordingly.
  // confirm=true: combine create + confirm in one call (atomic).
  // Metadata mirrors what create-session would put on the Checkout
  // Session so the webhook OR the inline fulfillment path can read
  // the same shape — though for the inline path we fulfill right
  // here and don't rely on the webhook.
  const metadata: Record<string, string> = {
    tier: 'audit',
    source: 'audit_upgrade',
    upgrade_placement: 'order_success',
    original_lead_order_id: leadOrder.id,
    inline_confirm: 'true',
  };
  if (originalScan) metadata.original_scan_id = originalScan.id;
  if (client) metadata.client_id = client.id;
  else metadata.pending_client_session_id = body.session_id;
  if (prospectIdFromMetadata) metadata.prospect_id = prospectIdFromMetadata;

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: UPGRADE_PRICE_CENTS,
      currency: UPGRADE_PRICE_CURRENCY,
      customer: customerId,
      payment_method: paymentMethod.id,
      off_session: true,
      confirm: true,
      metadata,
      // Description shows up in Stripe dashboard + email receipts.
      description: 'TurfMap Visibility Audit upgrade — 90-day Roadmap',
    });
  } catch (e: unknown) {
    // Off-session confirm errors include 'authentication_required'
    // when the issuer demands 3DS. Stripe.js can handle the
    // challenge inline but we're not loaded client-side — punt to
    // the Stripe Checkout flow, which handles 3DS UI natively.
    const err = e as {
      code?: string;
      message?: string;
      decline_code?: string;
    };
    if (err.code === 'authentication_required') {
      return NextResponse.json({
        fallback_to_checkout: true,
        reason: 'authentication_required',
      });
    }
    return NextResponse.json(
      {
        error: `payment confirmation failed: ${err.message ?? String(e)}`,
        decline_code: err.decline_code ?? null,
      },
      { status: 402 }
    );
  }

  // PaymentIntent.status can be 'succeeded', 'requires_action',
  // 'requires_payment_method', etc. Off-session confirm typically
  // returns succeeded OR throws (handled above). Belt-and-braces:
  if (paymentIntent.status !== 'succeeded') {
    if (paymentIntent.status === 'requires_action') {
      return NextResponse.json({
        fallback_to_checkout: true,
        reason: 'authentication_required',
      });
    }
    return NextResponse.json(
      {
        error: `unexpected PaymentIntent status: ${paymentIntent.status}`,
      },
      { status: 502 }
    );
  }

  // ─── 7. Synchronous fulfillment ────────────────────────────────────
  // No checkout.session.completed webhook will fire for this path
  // (we bypassed Stripe Checkout). Run the same audit-fulfillment
  // logic that handleAuditUpgradeCompletion runs in the webhook,
  // inline. When client doesn't exist yet (pre-intake upgrade), we
  // create a pending lead_orders row; /api/orders/fulfill sweeps it
  // when the buyer submits intake.
  const buyerEmail =
    leadOrder.email ??
    sessionResult.customerEmail ??
    null;
  const isPendingIntake = client === null || originalScan === null;

  const { data: newLeadOrder, error: leadInsertErr } = await supabase
    .from('lead_orders')
    .insert({
      // No Stripe Checkout session for this purchase — use the
      // PaymentIntent id as the unique stripe_session_id (this
      // column is the "tie to Stripe object id" — PI id works).
      stripe_session_id: paymentIntent.id,
      tier: 'audit',
      email: buyerEmail,
      client_id: client?.id ?? null,
      status: isPendingIntake ? 'pending' : 'fulfilled',
      stripe_metadata: {
        source: 'audit_upgrade',
        upgrade_placement: 'order_success',
        inline_confirm: true,
        original_scan_id: originalScan?.id ?? null,
        original_lead_order_id: leadOrder.id,
        pending_client_session_id: client ? null : body.session_id,
        prospect_id: prospectIdFromMetadata,
        amount_total: paymentIntent.amount,
        payment_intent_id: paymentIntent.id,
        audit_call_status: 'unbooked',
        audit_call_initiated_at: new Date().toISOString(),
      },
    })
    .select('*')
    .single<LeadOrderRow>();

  if (leadInsertErr || !newLeadOrder) {
    console.error(
      '[upgrade/confirm] lead_orders insert failed',
      leadInsertErr?.message
    );
    // Charge already succeeded — return success but flag the issue.
    // Operator can manually reconcile from Stripe.
    return NextResponse.json({
      ok: true,
      payment_intent_id: paymentIntent.id,
      warning: 'fulfillment_record_failed',
    });
  }

  // ─── Operator Slack notification (#llm-leads) ──────────────────────
  // Fires for EVERY successful audit-upgrade charge. Both the pending-
  // intake branch and the full-inline branch reach this point on a
  // successful PaymentIntent, so notifying here covers both.
  //
  // Fail-soft — the upgrade is already paid + recorded; a missing
  // Slack ping shouldn't surface as an error to the buyer.
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  try {
    await notifyAuditUpgradePurchase({
      businessName:
        client?.business_name ??
        sessionResult.intake?.businessName ??
        sessionResult.customerEmail ??
        '(unknown buyer)',
      amountCents: UPGRADE_PRICE_CENTS,
      fromTier: sessionResult.tier,
      originalLeadOrderId: leadOrder.id,
      utmSource: sessionResult.utmSource,
      prospectId: prospectIdFromMetadata,
      auditDashboardUrl: client
        ? agencyClientUrl(origin, client.public_id)
        : '',
    });
  } catch (e) {
    console.error(
      '[upgrade/confirm] notifyAuditUpgradePurchase failed (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }

  // Pending-intake path: stop here, /api/orders/fulfill picks up
  // the rest when the buyer submits the scan intake form.
  if (isPendingIntake || !client || !originalScan) {
    return NextResponse.json({
      ok: true,
      payment_intent_id: paymentIntent.id,
      lead_order_id: newLeadOrder.id,
      pending_intake: true,
    });
  }

  // Full inline fulfillment path: client + scan exist (the buyer
  // submitted intake BEFORE clicking upgrade — atypical with the
  // new Sprint-3 ordering, but supported for completeness).
  // Compute LLM Fit Score with conservative null inputs. The inline
  // confirm path runs synchronously inside the request — we don't
  // want to block on richer signal lookups here. The webhook path's
  // richer fit-score computation isn't materially better given we
  // don't have Apollo/revenue data at upgrade time either way.
  const fitBreakdown = computeLlmFitScore({
    revenueBand: null,
    tradeFit: null,
    metroFit: null,
    adActive: null,
    reviewCount: null,
  });

  const auditResult = await createVisibilityAudit(supabase, {
    leadOrderId: newLeadOrder.id,
    scanId: originalScan.id,
    clientId: client.id,
    startingTurfScore: originalScan.turf_score,
    liftPromiseTargetScore: null,
    llmFitScore: fitBreakdown.score,
    llmFitBreakdown: fitBreakdown,
  });
  if (!auditResult.ok) {
    console.error(
      '[upgrade/confirm] visibility_audits insert failed (non-fatal)',
      auditResult.error
    );
  }

  if (prospectIdFromMetadata) {
    try {
      await supabase
        .from('prospects')
        .update({ upgraded_to_audit_at: new Date().toISOString() })
        .eq('id', prospectIdFromMetadata)
        .is('upgraded_to_audit_at', null);
    } catch (e) {
      console.error(
        '[upgrade/confirm] prospects stamp failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return NextResponse.json({
    ok: true,
    payment_intent_id: paymentIntent.id,
    lead_order_id: newLeadOrder.id,
  });
}
