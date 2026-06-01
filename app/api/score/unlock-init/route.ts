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
      metadata: {
        source: 'score_unlock',
        share_id: share.id,
        client_id: client.id,
        scan_id: scan.id,
        business_name: client.business_name,
        tier: 'scan',
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
