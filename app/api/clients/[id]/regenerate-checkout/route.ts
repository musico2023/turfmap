/**
 * POST /api/clients/[id]/regenerate-checkout
 *
 * Generates a fresh Stripe Checkout link for a client that's stuck
 * in the "awaiting buyer payment setup" state — billing_mode=
 * 'self_serve_subscription' AND stripe_subscription_id IS NULL.
 *
 * Triggered when:
 *   - The original Checkout link from /api/clients expired (24h
 *     Stripe default)
 *   - The buyer abandoned and the operator wants to send another nudge
 *   - The operator wants to update the trial length or change the
 *     buyer's email before re-sending
 *
 * Body:
 *   {
 *     trial_days?: number,    // override; default 14
 *     buyer_email?: string    // override; default = clients.pending_buyer_email
 *   }
 *
 * Re-sends the auto-email and returns the fresh URL on success.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { getStripe } from '@/lib/stripe/client';
import { sendStripeSetupLink } from '@/lib/email/resend';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  trial_days: z.number().int().min(0).max(90).optional(),
  buyer_email: z.string().email().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
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

  // Only regenerate for clients in the awaiting-setup state. Anything
  // else means a re-Checkout shouldn't fire — they're already paying,
  // or they're agency-managed (no Stripe relationship at all).
  if (
    client.billing_mode !== 'self_serve_subscription' ||
    client.stripe_subscription_id ||
    !client.tier
  ) {
    return NextResponse.json(
      {
        error:
          'Client is not in awaiting-payment-setup state. Regenerate is only for self-serve subscriptions that haven\'t completed Checkout yet.',
      },
      { status: 400 }
    );
  }

  const buyerEmail = parsed.buyer_email ?? client.pending_buyer_email ?? null;
  if (!buyerEmail) {
    return NextResponse.json(
      {
        error:
          'No buyer email on file — pass buyer_email in the request body to set one.',
      },
      { status: 400 }
    );
  }

  const tier = client.tier as 'pulse' | 'pulse_plus';
  const priceEnvKey =
    tier === 'pulse_plus'
      ? 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY'
      : 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY';
  const priceId = process.env[priceEnvKey];
  if (!priceId) {
    return NextResponse.json(
      { error: `${priceEnvKey} not set` },
      { status: 503 }
    );
  }

  const stripe = await getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: 'STRIPE_SECRET_KEY is not set' },
      { status: 503 }
    );
  }

  const trialDays = parsed.trial_days ?? 14;
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';

  let checkoutUrl: string | null = null;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: buyerEmail,
      ...(trialDays > 0
        ? {
            subscription_data: {
              trial_period_days: trialDays,
              metadata: { client_id: client.id, plan: tier },
            },
          }
        : {
            subscription_data: {
              metadata: { client_id: client.id, plan: tier },
            },
          }),
      metadata: {
        tier,
        client_id: client.id,
      },
      success_url: `${origin}/clients/${client.public_id}?stripe_setup=complete`,
      cancel_url: `${origin}/clients/${client.public_id}?stripe_setup=cancelled`,
      allow_promotion_codes: true,
    });
    checkoutUrl = session.url ?? null;
  } catch (e) {
    return NextResponse.json(
      {
        error: `Stripe Checkout create failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }
  if (!checkoutUrl) {
    return NextResponse.json(
      { error: 'Stripe returned no Checkout URL' },
      { status: 502 }
    );
  }

  // Persist any buyer_email override so subsequent regenerates +
  // the audit trail reflect the latest address.
  if (parsed.buyer_email && parsed.buyer_email !== client.pending_buyer_email) {
    await supabase
      .from('clients')
      .update({ pending_buyer_email: parsed.buyer_email } satisfies Pick<
        ClientRow,
        'pending_buyer_email'
      >)
      .eq('id', client.id);
  }

  // Re-send the auto-email. Best-effort: the operator still gets
  // the URL in the response if email delivery fails.
  const emailSent = await sendStripeSetupLink({
    to: buyerEmail,
    businessName: client.business_name,
    tier,
    trialDays,
    checkoutUrl,
  });

  return NextResponse.json({
    ok: true,
    checkout_url: checkoutUrl,
    setup_email_sent: emailSent,
  });
}
