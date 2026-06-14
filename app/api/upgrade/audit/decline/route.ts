/**
 * POST /api/upgrade/audit/decline
 *
 * Stamps `lead_orders.audit_upgrade_declined_at` for the scan-tier
 * order associated with the Stripe Checkout session id. After this
 * fires:
 *   - The AuditUpgradePanel will NOT re-render on subsequent
 *     /order/success visits with the same session_id (the server
 *     reads the column on every render).
 *   - /api/upgrade/audit/create-session and
 *     /api/upgrade/audit/confirm reject upgrade attempts with 403
 *     for this session_id.
 *
 * Anthony policy 2026-06-13 ("option C"): the $197 Visibility Audit
 * upsell is a strict one-shot on /order/success. Clicking Skip in
 * the panel fires this endpoint; if the buyer reloads the page or
 * comes back via a stale tab, the panel is gone.
 *
 * Idempotent. Re-firing with the same session_id is a no-op
 * (preserves the original decline timestamp). Returns 204 on
 * success, 400 on missing/invalid session, 404 if no lead_order
 * matches.
 *
 * Auth model: the Stripe session_id IS the capability token. Same
 * pattern the other /api/upgrade/audit/* endpoints use — Stripe
 * issued it, it references a real paid scan, and it's short-lived
 * enough that we don't need session cookies on top.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import type { LeadOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 10;

const RequestBody = z.object({
  session_id: z.string().min(1),
});

export async function POST(req: Request) {
  let body: z.infer<typeof RequestBody>;
  try {
    body = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error: `invalid request body: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  const { data: leadOrder, error: lookupError } = await supabase
    .from('lead_orders')
    .select('id, audit_upgrade_declined_at')
    .eq('stripe_session_id', body.session_id)
    .maybeSingle<Pick<LeadOrderRow, 'id'> & {
      audit_upgrade_declined_at: string | null;
    }>();

  if (lookupError) {
    console.error(
      '[upgrade/audit/decline] lead_orders lookup failed',
      lookupError.message
    );
    return NextResponse.json(
      { error: 'lookup failed' },
      { status: 500 }
    );
  }

  if (!leadOrder) {
    return NextResponse.json(
      { error: 'no lead_orders row for this session' },
      { status: 404 }
    );
  }

  // Idempotent: preserve the original timestamp on re-fire.
  if (leadOrder.audit_upgrade_declined_at) {
    return new NextResponse(null, { status: 204 });
  }

  const { error: updateError } = await supabase
    .from('lead_orders')
    .update({ audit_upgrade_declined_at: new Date().toISOString() })
    .eq('id', leadOrder.id);

  if (updateError) {
    console.error(
      '[upgrade/audit/decline] update failed',
      updateError.message
    );
    return NextResponse.json(
      { error: 'update failed' },
      { status: 500 }
    );
  }

  return new NextResponse(null, { status: 204 });
}
