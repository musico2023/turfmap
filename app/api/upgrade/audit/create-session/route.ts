/**
 * POST /api/upgrade/audit/create-session
 *
 * Create a Stripe Checkout Session for the $197 Visibility Audit
 * upgrade — the second-stage offer in the cold-email funnel and
 * post-purchase upsell across all acquisition channels.
 *
 * Pricing math: list price $499 minus a $302 promotion-code
 * (UPGRADE_302_CREDIT) = $197. The credit equals the original
 * TurfScan purchase price, framed as "your $49 already counted"
 * even though the actual scan revenue stays in Stripe.
 *
 * Auth model — two paths, picked by `source`:
 *
 *   source: "order_success"
 *     The buyer just paid for TurfScan and landed on
 *     /order/success?session_id=cs_<id>. They aren't authenticated;
 *     the Stripe session_id IS their auth token (it was issued by
 *     Stripe, references a real paid scan, and is short-lived).
 *     Body MUST include session_id. We validate the session is
 *     tier=scan + payment_status=paid, then derive customer_id
 *     for the upgrade Checkout.
 *
 *   source: "dashboard"
 *     Buyer is signed into the agency dashboard (/clients/<id>) or
 *     buyer portal (/portal/<id>). Body MUST include client_id;
 *     we look up the client's most recent fulfilled scan-tier
 *     lead_orders row to derive customer_id.
 *
 * Gates (return 4xx if violated):
 *   - 400: missing required body fields
 *   - 400: source=order_success + session_id doesn't resolve to
 *     a paid TurfScan
 *   - 400: client has no TurfScan purchase history
 *   - 400: client has already upgraded to audit
 *   - 410: 24-hour upgrade window has expired
 *
 * Returns: { checkout_url, session_id }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getStripe, STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';
import { loadCheckoutSession } from '@/lib/stripe/session';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow, LeadOrderRow, ScanRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

// 24-hour upgrade window. After this, the buyer pays the full
// $499 standalone audit price (or buys it through the homepage
// pricing surface). Counted from the original TurfScan order
// creation timestamp — robust against scan-pipeline delays.
const UPGRADE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Stripe-side promotion-code that applies $302 off the audit tier.
// Must exist in the Stripe dashboard (operator creates it; not
// auto-provisioned). When missing, Checkout creation falls back to
// surfacing a clear error rather than silently charging $499.
const UPGRADE_COUPON_CODE = 'UPGRADE_302_CREDIT';

const RequestBody = z.object({
  source: z.enum(['order_success', 'dashboard', 'stage_2_email']),
  session_id: z.string().optional(),
  client_id: z.string().uuid().optional(),
  /** Required when source='stage_2_email'. The warm-cohort prospect
   *  identifier acts as a capability token (same pattern /freescan
   *  + /yourmap use). The endpoint resolves the buyer's original
   *  TurfScan purchase via lead_orders.stripe_metadata.prospect_id. */
  prospect_id: z.string().optional(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof RequestBody>;
  try {
    body = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof z.ZodError ? e.issues[0].message : 'invalid body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // ─── 1. Resolve buyer identity (customer_id + lead_orders + scan) ──
  //
  // Two paths converge on the same triple: customer_id (Stripe),
  // leadOrder (audit-trail row), originalScan (for 24h window math
  // + visibility_audits.scan_id).
  let customerId: string | null = null;
  let leadOrder: LeadOrderRow | null = null;
  let client: ClientRow | null = null;
  let originalScan: ScanRow | null = null;
  let prospectIdFromMetadata: string | null = null;

  if (body.source === 'order_success') {
    if (!body.session_id) {
      return NextResponse.json(
        { error: 'session_id required for order_success source' },
        { status: 400 }
      );
    }
    // Validate the Stripe session — this rejects bogus / unpaid /
    // wrong-tier sessions before we burn an upgrade Checkout call.
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
    customerId = sessionResult.customerId;
    prospectIdFromMetadata = sessionResult.prospectId;

    const { data: lo } = await supabase
      .from('lead_orders')
      .select('*')
      .eq('stripe_session_id', body.session_id)
      .maybeSingle<LeadOrderRow>();
    leadOrder = lo;
    if (!leadOrder) {
      return NextResponse.json(
        { error: 'no lead_orders row for this session' },
        { status: 400 }
      );
    }
    if (leadOrder.client_id) {
      const { data: c } = await supabase
        .from('clients')
        .select('*')
        .eq('id', leadOrder.client_id)
        .maybeSingle<ClientRow>();
      client = c;
    }
  } else if (body.source === 'dashboard') {
    // source: 'dashboard' — derive from client_id.
    if (!body.client_id) {
      return NextResponse.json(
        { error: 'client_id required for dashboard source' },
        { status: 400 }
      );
    }
    const { data: c } = await supabase
      .from('clients')
      .select('*')
      .eq('id', body.client_id)
      .maybeSingle<ClientRow>();
    if (!c) {
      return NextResponse.json({ error: 'client not found' }, { status: 404 });
    }
    client = c;
    customerId = c.stripe_customer_id ?? null;

    // Find the original TurfScan lead_orders row for this client.
    const { data: lo } = await supabase
      .from('lead_orders')
      .select('*')
      .eq('client_id', c.id)
      .eq('tier', 'scan')
      .eq('status', 'fulfilled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<LeadOrderRow>();
    leadOrder = lo;
    if (!leadOrder) {
      return NextResponse.json(
        { error: 'no fulfilled TurfScan order found for this client' },
        { status: 400 }
      );
    }
    if (
      leadOrder.stripe_metadata &&
      typeof leadOrder.stripe_metadata === 'object' &&
      'prospect_id' in leadOrder.stripe_metadata
    ) {
      const m = leadOrder.stripe_metadata as Record<string, unknown>;
      prospectIdFromMetadata =
        typeof m.prospect_id === 'string' ? m.prospect_id : null;
    }
  } else {
    // source: 'stage_2_email' — warm-cohort buyer clicking through
    // from the CRM-reactivation Stage 2 audit-upgrade email. The
    // prospect_id is the capability token (same model /freescan +
    // /yourmap use). Look up the prospect's original TurfScan
    // lead_orders row via stripe_metadata.prospect_id and derive the
    // buyer's Stripe customer + scan from there.
    if (!body.prospect_id) {
      return NextResponse.json(
        { error: 'prospect_id required for stage_2_email source' },
        { status: 400 }
      );
    }
    prospectIdFromMetadata = body.prospect_id;

    // Confirm the prospect actually exists + has converted (gates
    // against bogus IDs or pre-purchase clicks landing here).
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id, converted_at')
      .eq('id', body.prospect_id)
      .maybeSingle<{ id: string; converted_at: string | null }>();
    if (!prospect) {
      return NextResponse.json(
        { error: 'prospect not found' },
        { status: 404 }
      );
    }
    if (!prospect.converted_at) {
      return NextResponse.json(
        { error: 'prospect has not purchased a TurfScan yet' },
        { status: 400 }
      );
    }

    // Find the prospect's TurfScan lead_orders row. The fulfill route
    // stamps stripe_metadata.prospect_id when the cohort buyer
    // completes their scan checkout (see /api/orders/fulfill).
    const { data: lo } = await supabase
      .from('lead_orders')
      .select('*')
      .eq('tier', 'scan')
      .filter(
        'stripe_metadata->>prospect_id',
        'eq',
        body.prospect_id
      )
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<LeadOrderRow>();
    leadOrder = lo;
    if (!leadOrder) {
      return NextResponse.json(
        { error: 'no TurfScan lead_orders row for this prospect' },
        { status: 400 }
      );
    }
    if (leadOrder.client_id) {
      const { data: c } = await supabase
        .from('clients')
        .select('*')
        .eq('id', leadOrder.client_id)
        .maybeSingle<ClientRow>();
      client = c;
      customerId = c?.stripe_customer_id ?? null;
    }

    // If we still don't have a customerId, try the stripe_session_id
    // route — the original scan session's customer is the same
    // record we'd pre-bind on the upgrade Checkout.
    if (!customerId && leadOrder.stripe_session_id) {
      const sessionResult = await loadCheckoutSession(
        leadOrder.stripe_session_id
      );
      if (!('kind' in sessionResult)) {
        customerId = sessionResult.customerId;
      }
    }
  }

  // customerId is now best-effort, not required. When present, the
  // upgrade Checkout pre-binds to the same Stripe customer so the
  // buyer doesn't re-enter their email + card. When absent (e.g.
  // pre-fix scan purchases that ran under customer_creation:
  // 'if_required' and didn't save payment), Stripe collects fresh
  // contact details on the upgrade Checkout. We still fulfill the
  // upgrade correctly because the webhook attribution rides on
  // metadata.original_lead_order_id, not the customer record.
  // leadOrder is still required (it's the original scan purchase
  // record), but `client` is now also best-effort. When the buyer
  // upgrades BEFORE filling the post-checkout intake form, the
  // client row doesn't exist yet. In that case we proceed with a
  // 'pending intake' upgrade: the webhook creates the audit
  // lead_orders row with client_id=null, /api/orders/fulfill sweeps
  // it when the buyer eventually submits intake, links client_id,
  // creates the visibility_audits row, and stamps
  // prospects.upgraded_to_audit_at. The buyer experiences the
  // upgrade as: see panel → click Add → pay → return to intake
  // form (no second-payment friction).
  if (!leadOrder) {
    return NextResponse.json(
      { error: 'no lead_orders row for this session' },
      { status: 400 }
    );
  }

  // ─── 2. Already-upgraded check ─────────────────────────────────────
  // If the client already has a visibility_audits row, refuse to
  // create another upgrade — they've either already upgraded OR
  // their original purchase was at the audit tier. Only enforceable
  // when client exists (pre-intake upgrades skip this check; the
  // webhook idempotency on stripe_session_id prevents the dup case
  // even without it).
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

  // ─── 3. 24h window check ───────────────────────────────────────────
  // Counted from the original lead_orders.created_at (when the buyer
  // hit Stripe Checkout). This is the spec'd "scan completed" window
  // — using lead_order timestamp is a more reliable proxy than
  // scans.completed_at, which can drift if the scan pipeline retries.
  const orderAge = Date.now() - new Date(leadOrder.created_at).getTime();
  if (orderAge > UPGRADE_WINDOW_MS) {
    return NextResponse.json(
      {
        error: 'upgrade window expired',
        order_created_at: leadOrder.created_at,
        upgrade_window_hours: 24,
      },
      { status: 410 }
    );
  }

  // Pull the original scan_id so the upgrade webhook can stamp it
  // onto visibility_audits without re-querying. Only runs when the
  // client already exists (i.e. intake submitted). When upgrading
  // BEFORE intake, the scan hasn't been created yet — the webhook
  // creates a pending audit lead_orders row with scan_id null, and
  // /api/orders/fulfill creates both scan + visibility_audits when
  // intake completes.
  if (client) {
    const { data: scan } = await supabase
      .from('scans')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ScanRow>();
    originalScan = scan;
    if (!originalScan) {
      return NextResponse.json(
        {
          error:
            'no scan found for client yet — wait for the original scan to complete before upgrading',
        },
        { status: 400 }
      );
    }
  }

  // ─── 4. Resolve audit price + create upgrade session ───────────────
  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
  }

  const auditPriceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_AUDIT;
  if (!auditPriceId) {
    return NextResponse.json(
      { error: 'audit price id not configured' },
      { status: 503 }
    );
  }

  // Resolve the upgrade promotion code to its Stripe id. Same
  // pattern /api/checkout/[tier] uses for FOURDOTS50/MAPCHECK50.
  let upgradePromoId: string | null = null;
  try {
    const promos = await stripe.promotionCodes.list({
      code: UPGRADE_COUPON_CODE,
      active: true,
      limit: 1,
    });
    upgradePromoId = promos.data[0]?.id ?? null;
  } catch (e) {
    console.error(
      '[upgrade] promo code lookup failed (non-fatal — falling back to auto-discount path)',
      e instanceof Error ? e.message : String(e)
    );
  }
  if (!upgradePromoId) {
    return NextResponse.json(
      {
        error: `promotion code ${UPGRADE_COUPON_CODE} not found in Stripe — operator must create it before this endpoint can fire`,
      },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const origin = req.headers.get('origin') ?? url.origin;

  // Build attribution metadata for the upgrade session. The webhook
  // reads source=audit_upgrade to differentiate from a standalone
  // $499 audit purchase + writes the right visibility_audits row.
  //
  // client_id is included only when the client row exists (i.e. the
  // buyer already submitted intake before clicking upgrade). When
  // they upgrade BEFORE intake, we instead stamp
  // pending_client_session_id so /api/orders/fulfill can sweep the
  // pending upgrade row when the client is eventually created.
  const attribution: Record<string, string> = {
    tier: 'audit',
    source: 'audit_upgrade',
    upgrade_placement: body.source,
    original_lead_order_id: leadOrder.id,
  };
  if (originalScan) {
    attribution.original_scan_id = originalScan.id;
  }
  if (client) {
    attribution.client_id = client.id;
  } else if (body.session_id) {
    attribution.pending_client_session_id = body.session_id;
  }
  if (prospectIdFromMetadata) attribution.prospect_id = prospectIdFromMetadata;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      // When customerId is present, pre-bind the upgrade Checkout so
      // the buyer skips email + card re-entry. When absent (legacy
      // 'if_required' purchases), let Stripe collect fresh contact
      // info and auto-create a customer at upgrade time.
      ...(customerId
        ? { customer: customerId }
        : { customer_creation: 'always' as const }),
      line_items: [{ price: auditPriceId, quantity: 1 }],
      discounts: [{ promotion_code: upgradePromoId }],
      // success_url routes back to the ORIGINAL scan session, not
      // the new audit session. The page reads session_id and renders
      // the post-scan intake form (still scan tier). The ?upgrade=audit
      // flag tells the page to surface an "audit purchased ✓" banner
      // above the intake form. The audit lead_orders row is created
      // server-side by the webhook (in pending state if client not yet
      // resolved, else fulfilled) — the success page doesn't need to
      // know the audit Checkout session id at all.
      success_url:
        body.source === 'order_success' && body.session_id
          ? `${origin}/order/success?upgrade=audit&session_id=${body.session_id}`
          : `${origin}/order/success?upgrade=audit&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:
        body.source === 'order_success'
          ? `${origin}/order/success?session_id=${body.session_id}`
          : body.source === 'stage_2_email' && body.prospect_id
            ? `${origin}/audit-upgrade?source=stage_2_email&prospect_id=${body.prospect_id}&cancelled=1`
            : client
              ? `${origin}/portal/${client.public_id}`
              : `${origin}/`,
      metadata: attribution,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Stripe upgrade-session create failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }

  if (!session.url) {
    return NextResponse.json(
      { error: 'Stripe returned no checkout URL' },
      { status: 502 }
    );
  }

  return NextResponse.json({
    checkout_url: session.url,
    session_id: session.id,
  });
}
