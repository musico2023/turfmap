/**
 * POST /api/audits/[id]/deliver
 *
 * Marks an audit-tier order as delivered to the buyer. Stamps
 * lead_orders.delivered_at = now() and returns the timestamp so the
 * client UI can flip into the read-only "delivered" state without
 * a full reload.
 *
 * Phase 1: this endpoint is purely a state transition — the operator
 * has already manually emailed the customized PDF URL to the buyer
 * and is recording that the delivery happened.
 *
 * Phase 2 will extend this to:
 *   - Send the PDF via Resend with a templated email
 *   - Schedule the bundled re-scans (30-day for Visibility Audit;
 *     60+90-day for Strategy Session)
 *   - Send a strategist follow-up calendar link if applicable
 *
 * Pre-conditions: a delivery_pdf_url must exist (you can't deliver
 * what you haven't generated). Once delivered, repeated calls 409.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { LeadOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const supabase = getServerSupabase();

  const { data: order } = await supabase
    .from('lead_orders')
    .select('id, tier, delivery_pdf_url, delivered_at')
    .eq('id', id)
    .maybeSingle<
      Pick<LeadOrderRow, 'id' | 'tier' | 'delivery_pdf_url' | 'delivered_at'>
    >();

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }
  if (order.tier !== 'audit' && order.tier !== 'strategy') {
    return NextResponse.json(
      {
        error: `tier "${order.tier}" doesn't have a strategist-managed delivery`,
      },
      { status: 400 }
    );
  }
  if (order.delivered_at) {
    return NextResponse.json(
      {
        error: 'order is already delivered',
        delivered_at: order.delivered_at,
      },
      { status: 409 }
    );
  }
  if (!order.delivery_pdf_url) {
    return NextResponse.json(
      {
        error:
          "no customized PDF generated yet — generate it first, then mark delivered",
      },
      { status: 422 }
    );
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('lead_orders')
    .update({ delivered_at: now })
    .eq('id', id);

  if (error) {
    return NextResponse.json(
      { error: `update failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    delivered_at: now,
  });
}
