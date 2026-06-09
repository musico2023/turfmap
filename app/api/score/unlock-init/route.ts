/**
 * POST /api/score/unlock-init
 *
 * Fires when a buyer hits the "Unlock the full map — $99" CTA on a
 * preview-mode /share/<id>. Creates a Stripe Checkout session that,
 * on success, triggers the score_unlock webhook handler — which
 * flips clients.is_preview=false, generates AI Coach, provisions
 * portal access, sends emails, and inserts a lead_orders row.
 *
 * Buyer redirects to /order/success?session_id=... per the user's
 * decision (A): same path as a standalone TurfScan buyer, so the
 * audit-upgrade panel + proper "your scan is ready" UX still fires.
 *
 * Idempotency: if the share's client is already non-preview (i.e.
 * unlocked previously), we don't open a new Checkout — we just
 * redirect the buyer to /share/<id> (which now renders full mode).
 * Catches the "buyer clicks Unlock twice" UX race.
 *
 * Errors:
 *   400 — invalid body
 *   404 — share / client not found
 *   409 — already unlocked (returns share URL for re-display)
 *   410 — share expired or revoked
 *   503 — Stripe not configured
 *   502 — Stripe API error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getStripe, STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  isDiscountedLeadSource,
  unlockCouponCodeForLeadSource,
} from '@/lib/score/leadSources';
import type { ClientRow, ScanShareLinkRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  share_id: z.string().uuid(),
});

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
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

  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
  }

  const supabase = getServerSupabase();

  // ─── 1. Resolve the share + its parent client ──────────────────────
  const { data: share } = await supabase
    .from('scan_share_links')
    .select('id, scan_id, expires_at, revoked_at')
    .eq('id', body.share_id)
    .maybeSingle<
      Pick<ScanShareLinkRow, 'id' | 'scan_id' | 'expires_at' | 'revoked_at'>
    >();
  if (!share) {
    return NextResponse.json({ error: 'share not found' }, { status: 404 });
  }
  if (share.revoked_at) {
    return NextResponse.json({ error: 'share revoked' }, { status: 410 });
  }
  if (new Date(share.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'share expired' }, { status: 410 });
  }

  const { data: scan } = await supabase
    .from('scans')
    .select('id, client_id')
    .eq('id', share.scan_id)
    .maybeSingle<{ id: string; client_id: string }>();
  if (!scan) {
    return NextResponse.json({ error: 'scan not found' }, { status: 404 });
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, business_name, is_preview, stripe_customer_id, public_id')
    .eq('id', scan.client_id)
    .maybeSingle<
      Pick<
        ClientRow,
        'id' | 'business_name' | 'is_preview' | 'stripe_customer_id' | 'public_id'
      >
    >();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // ─── 2. Already unlocked? short-circuit ─────────────────────────────
  // The buyer clicked Unlock on a share that's already full-mode.
  // Don't open another Checkout — just send them back to the share
  // which will render in full mode.
  if (!client.is_preview) {
    return NextResponse.json(
      {
        ok: true,
        already_unlocked: true,
        share_url: `/share/${share.id}`,
        // Echo a "url" field so the UnlockShareButton's existing
        // window.location.assign(data.url) path doesn't need a
        // separate branch — the redirect just goes to the unlocked
        // share instead of Stripe.
        url: `/share/${share.id}`,
      },
      { status: 409 }
    );
  }

  // ─── 3. Resolve the $99 TurfScan Price ──────────────────────────────
  // Same Stripe Price ID used for standalone TurfScan checkouts. The
  // env validation matches /api/scan/checkout/init's pattern so a
  // misconfigured deploy fails loudly.
  const priceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_SCAN;
  if (!priceId) {
    return NextResponse.json(
      {
        error:
          'Unlock not configured: NEXT_PUBLIC_STRIPE_PRICE_SCAN must be set.',
      },
      { status: 503 }
    );
  }

  // ─── 3a. Resolve cohort-conditional discount ────────────────────────
  // Cold-Meta /free-score buyers get MAPCHECK50 ($99 → $49) auto-
  // applied here on the unlock — the lander promised them a $49
  // unlock so we honor it without making them type the code.
  // Homepage /score buyers stay at $99 list (no discount).
  //
  // The lead_source signal lives in the original lead_orders row that
  // createPreviewClient inserted at preview time. We look it up via
  // the client_id; that row has source='score_preview' and a
  // lead_source key under stripe_metadata.
  let unlockLeadSource: string | null = null;
  {
    const { data: leadOrder } = await supabase
      .from('lead_orders')
      .select('stripe_metadata')
      .eq('client_id', client.id)
      .eq('tier', 'scan')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ stripe_metadata: Record<string, unknown> | null }>();
    const meta = leadOrder?.stripe_metadata ?? null;
    if (meta && typeof meta.lead_source === 'string') {
      unlockLeadSource = meta.lead_source;
    }
  }
  // Discount eligibility comes from a shared helper so /share's UI
  // display flag and this server-side coupon decision can't drift.
  // See lib/score/leadSources.ts for the canonical set.
  const applyDiscount = isDiscountedLeadSource(unlockLeadSource);

  // Resolve which Stripe promotion code to apply per lead_source —
  // MAPCHECK50 for cold-Meta cohorts (free_score / prove_it),
  // FOURDOTS50 for the fourdots.io exit-intent + downsell cohort.
  // Discount math is identical ($99 → $49) but the codes are kept
  // distinct in Stripe so channel attribution stays clean in the
  // unit-economics rollup.
  //
  // Soft-fails — if Stripe doesn't return the code, the buyer still
  // gets to Checkout at list ($99) rather than being blocked. We
  // surface the failure in server logs.
  const couponCode = unlockCouponCodeForLeadSource(unlockLeadSource);
  let discounts: Array<{ promotion_code: string }> | undefined;
  let appliedCouponCode: string | null = null;
  if (applyDiscount && couponCode) {
    try {
      const promos = await stripe.promotionCodes.list({
        code: couponCode,
        active: true,
        limit: 1,
      });
      if (promos.data[0]?.id) {
        discounts = [{ promotion_code: promos.data[0].id }];
        appliedCouponCode = couponCode;
      } else {
        console.warn(
          `[score/unlock-init] ${couponCode} promotion code not found in Stripe — falling back to list price.`
        );
      }
    } catch (e) {
      console.warn(
        `[score/unlock-init] ${couponCode} lookup failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  const url = new URL(req.url);
  const origin = req.headers.get('origin') ?? url.origin;

  // ─── 4. Build the Stripe Checkout session ───────────────────────────
  // Metadata is what the webhook reads to know:
  //   - source='score_unlock'  → dispatch to handleScoreUnlockCompletion
  //   - share_id, client_id    → which preview to unlock
  //   - business_name          → for downstream emails (operator + buyer)
  //
  // success_url points at /order/success per the user's decision (A):
  // the score_unlock buyer flows through the same post-purchase UX
  // as a standalone TurfScan buyer (audit-upgrade panel, "your scan
  // is ready" framing). The webhook does the actual unlock work
  // before the buyer's browser even reaches that page.
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Reuse the prior Stripe customer record when we already have
      // one for this client (rare on the unlock path since preview
      // clients don't go through a prior Checkout — but defensive).
      // Otherwise let Stripe create one.
      ...(client.stripe_customer_id
        ? { customer: client.stripe_customer_id }
        : { customer_creation: 'always' as const }),
      payment_intent_data: {
        // Save the card for any subsequent audit-upgrade Checkout the
        // /order/success page might surface — same pattern as the
        // standard scan-intake checkout.
        setup_future_usage: 'off_session' as const,
      },
      success_url: `${origin}/order/success?tier=scan&session_id={CHECKOUT_SESSION_ID}&unlocked=1`,
      cancel_url: `${origin}/share/${share.id}?unlock_cancelled=1`,
      // Apply MAPCHECK50 ($99 → $49) when the original preview came
      // from the cold-Meta /free-score lander. Pre-applied here so the
      // buyer never has to type the code — they came from a lander
      // that promised them $49.
      ...(discounts ? { discounts } : {}),
      metadata: {
        source: 'score_unlock',
        share_id: share.id,
        client_id: client.id,
        scan_id: scan.id,
        business_name: client.business_name,
        tier: 'scan',
        // Propagate the lander identifier so handleScoreUnlockCompletion
        // and any downstream attribution reporting can see which
        // funnel converted. 'unknown' when the original preview row
        // is missing the metadata (defensive against pre-migration data).
        unlock_lead_source: unlockLeadSource ?? 'unknown',
        // Tag which /share UI variant this buyer converted from. The
        // re-gate ticket §10 asked for a marker so future-version
        // unlocks can be split in SQL without depending on guess-by-
        // timestamp. Hardcoded to the current shipped variant since
        // we're not running A/B; bump the slug when /share changes.
        share_variant: 'v2_competitor_names_locked',
        ...(appliedCouponCode ? { applied_coupon: appliedCouponCode } : {}),
      },
    });
    if (!session.url) {
      return NextResponse.json(
        { error: 'Stripe returned no checkout URL' },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Stripe Checkout failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 502 }
    );
  }
}
