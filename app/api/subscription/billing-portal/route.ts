/**
 * POST /api/subscription/billing-portal
 *
 * Agency-gated. Operator opens the Stripe Customer Portal for a
 * client. Returns { url } that the agency dashboard redirects to in
 * a new tab so the operator can update payment methods, view
 * invoices, or trigger cancellations on the client's behalf.
 *
 * Body: { client_id }
 *
 * The portal session expires automatically per Stripe's defaults
 * (~24h). We return the URL fresh on every call rather than caching.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { createBillingPortalSession } from '@/lib/stripe/subscription';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
  /** Where to send the buyer/operator after they close the portal.
   *  Defaults to the agency client dashboard. Validated as
   *  same-origin to prevent open-redirect abuse. */
  return_path: z.string().startsWith('/').optional(),
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
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data: client } = await supabase
    .from('clients')
    .select('id, public_id, stripe_customer_id')
    .eq('id', parsed.client_id)
    .maybeSingle<Pick<ClientRow, 'id' | 'public_id' | 'stripe_customer_id'>>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  if (!client.stripe_customer_id) {
    return NextResponse.json(
      {
        error:
          'no Stripe customer on file for this client. Self-serve subscriptions get one via Checkout; agency-managed clients need to be set up manually in Stripe first.',
      },
      { status: 400 }
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';
  const returnUrl = `${origin}${parsed.return_path ?? `/clients/${client.public_id}/settings`}`;

  const result = await createBillingPortalSession({
    customerId: client.stripe_customer_id,
    returnUrl,
  });
  if (!result.ok) {
    const status = result.kind === 'stripe_not_configured' ? 503 : 502;
    return NextResponse.json({ error: result.message }, { status });
  }
  return NextResponse.json({ ok: true, url: result.url });
}
