/**
 * Auth helper for buyer-side onboarding endpoints (`/api/onboarding/...`).
 *
 * The buyer is post-checkout but pre-portal-login: they don't have an
 * agency-staff session and they may not have set up portal access yet.
 * They DO have a Stripe Checkout session id (`cs_...`) — Stripe handed
 * it back when they paid, and it's in the URL on `/order/success`.
 *
 * We treat that session_id as proof of ownership for the client tied
 * to it: lead_orders.stripe_session_id is unique and links to a
 * specific lead_orders.client_id. If the session matches AND the row
 * is fulfilled AND the resolved client_id matches the URL public_id,
 * the buyer is authorized for that client's onboarding endpoints.
 *
 * The check is read-only against lead_orders, so cost is one indexed
 * query per request — negligible.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type OnboardingAuthResult =
  | { ok: true; clientId: string; publicId: string }
  | { ok: false; response: NextResponse };

/**
 * Verify a Stripe session_id authorizes mutations for the client at
 * `publicIdOrUuid`. Returns either { ok: true, clientId } so the caller
 * can proceed, or a ready-to-return NextResponse with the right error.
 */
export async function requireOnboardingSession(
  supabase: SupabaseLike,
  args: { sessionId: string | null | undefined; publicIdOrUuid: string }
): Promise<OnboardingAuthResult> {
  if (!args.sessionId || typeof args.sessionId !== 'string') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'sessionId required' },
        { status: 401 }
      ),
    };
  }

  const client = await findClientByPublicIdOrUuid(supabase, args.publicIdOrUuid);
  if (!client) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'client not found' },
        { status: 404 }
      ),
    };
  }

  const { data: order } = await supabase
    .from('lead_orders')
    .select('id, status, client_id')
    .eq('stripe_session_id', args.sessionId)
    .maybeSingle<{ id: string; status: string; client_id: string | null }>();

  if (!order || order.client_id !== client.id || order.status !== 'fulfilled') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'session does not authorize this client' },
        { status: 403 }
      ),
    };
  }

  return { ok: true, clientId: client.id, publicId: client.public_id };
}
