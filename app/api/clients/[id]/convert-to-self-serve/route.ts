/**
 * POST /api/clients/[id]/convert-to-self-serve
 *
 * Mirror of /api/clients/[id]/convert-to-managed. Used when an
 * agency-managed client wants to move to a Stripe-billed Pulse /
 * Pulse+ subscription — typically a managed-contract buyer who's
 * graduating off white-glove and onto self-serve recurring.
 *
 * Body:
 *   {
 *     tier: 'pulse' | 'pulse_plus',
 *     buyer_email: string,
 *     trial_days?: number   // default 14
 *   }
 *
 * Two-sided flow: this endpoint can't capture payment (PCI / compliance —
 * operators shouldn't handle PANs). So:
 *
 *   1. Pre-flip the row: billing_mode='self_serve_subscription',
 *      tier=<chosen>, pending_buyer_email=<provided>. Stripe IDs
 *      stay null until step 3.
 *   2. Generate a Stripe Checkout session with subscription_data.
 *      metadata.client_id pointing at the existing row + email
 *      the buyer the link via sendStripeSetupLink.
 *   3. Buyer clicks the link, completes Checkout, Stripe fires
 *      customer.subscription.created — the existing webhook
 *      handler stamps stripe_customer_id, stripe_subscription_id,
 *      tier, subscription_status. Same plumbing as marketing-
 *      tripwire buyers.
 *
 * If the buyer never completes Checkout, the row sits in the
 * "awaiting payment setup" state (AwaitingPaymentSetupCard
 * renders on settings) — operator can resend the link via
 * regenerate-checkout, or convert back to agency-managed via
 * convert-to-managed.
 *
 * Domain-gated to fourdots-owner emails (defense in depth on top
 * of the standard agency-staff check), since this is an
 * operationally significant billing-mode flip.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  isAgencyOwnerEmail,
  requireAgencyUserForApi,
} from '@/lib/auth/agency';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { getStripe } from '@/lib/stripe/client';
import { sendStripeSetupLink } from '@/lib/email/resend';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  tier: z.enum(['pulse', 'pulse_plus']),
  buyer_email: z.string().email(),
  trial_days: z.number().int().min(0).max(90).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json(
      {
        error:
          'Restricted action — only agency-owner accounts can convert clients to self-serve billing.',
      },
      { status: 403 }
    );
  }

  const { id: clientParam } = await params;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Only agency-managed clients are conversion targets. self_serve
  // already has Stripe billing; one_time is a one-shot product with
  // no recurring relationship to migrate.
  if (client.billing_mode !== 'agency_managed') {
    return NextResponse.json(
      {
        error: `Client billing mode is "${client.billing_mode}". Only agency-managed clients can be converted to self-serve.`,
      },
      { status: 400 }
    );
  }

  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: 'STRIPE_SECRET_KEY is not set' },
      { status: 503 }
    );
  }
  const priceEnvKey =
    parsed.tier === 'pulse_plus'
      ? 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY'
      : 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY';
  const priceId = process.env[priceEnvKey];
  if (!priceId) {
    return NextResponse.json(
      { error: `${priceEnvKey} not set` },
      { status: 503 }
    );
  }

  // ─── Step 1: Pre-flip the row ─────────────────────────────────────────
  // Why first: when the buyer completes Checkout, Stripe fires
  // customer.subscription.created → our webhook syncSubscription
  // looks up by metadata.client_id, finds this row, and writes
  // stripe IDs + status. We want the row already in
  // 'self_serve_subscription' mode at that point so the webhook's
  // agency-managed guard doesn't suppress the tier write.
  //
  // Also clear stripe_subscription_id even though it's likely null
  // already — defensive, in case this row came through
  // convert-to-managed previously and still has a (canceled) sub
  // ID stamped from that flow's audit trail.
  const update: Partial<
    Pick<
      ClientRow,
      'billing_mode' | 'tier' | 'pending_buyer_email' | 'stripe_subscription_id'
    >
  > = {
    billing_mode: 'self_serve_subscription',
    tier: parsed.tier,
    pending_buyer_email: parsed.buyer_email,
    stripe_subscription_id: null,
  };
  const { error: updateError } = await supabase
    .from('clients')
    .update(update)
    .eq('id', client.id);
  if (updateError) {
    return NextResponse.json(
      { error: `client update failed: ${updateError.message}` },
      { status: 500 }
    );
  }

  // ─── Step 2: Generate Stripe Checkout session + email it ───────────────
  const trialDays = parsed.trial_days ?? 14;
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';

  let checkoutUrl: string | null = null;
  let emailSent = false;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: parsed.buyer_email,
      ...(trialDays > 0
        ? {
            subscription_data: {
              trial_period_days: trialDays,
              metadata: { client_id: client.id, plan: parsed.tier },
            },
          }
        : {
            subscription_data: {
              metadata: { client_id: client.id, plan: parsed.tier },
            },
          }),
      metadata: {
        tier: parsed.tier,
        client_id: client.id,
      },
      success_url: `${origin}/clients/${client.public_id}?stripe_setup=complete`,
      cancel_url: `${origin}/clients/${client.public_id}?stripe_setup=cancelled`,
      allow_promotion_codes: true,
    });
    checkoutUrl = session.url ?? null;
    if (checkoutUrl) {
      emailSent = await sendStripeSetupLink({
        to: parsed.buyer_email,
        businessName: client.business_name,
        tier: parsed.tier,
        trialDays,
        checkoutUrl,
      });
    }
  } catch (e) {
    // Row is already flipped to self-serve. The Checkout session
    // generation failed — operator can regenerate via the
    // AwaitingPaymentSetupCard's regenerate button without
    // re-running this conversion.
    return NextResponse.json(
      {
        ok: true,
        billing_mode: 'self_serve_subscription',
        tier: parsed.tier,
        checkout_url: null,
        setup_email_sent: false,
        warning: `Conversion saved but Checkout session failed: ${e instanceof Error ? e.message : String(e)}. Use the "Regenerate link" button on the awaiting-payment card to retry.`,
      },
      { status: 200 }
    );
  }

  return NextResponse.json({
    ok: true,
    billing_mode: 'self_serve_subscription',
    tier: parsed.tier,
    checkout_url: checkoutUrl,
    setup_email_sent: emailSent,
  });
}
