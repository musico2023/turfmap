/**
 * PATCH /api/audits/[id]/notes
 *
 * Update the strategist_notes field on a lead_orders row. Used by
 * the audit-delivery detail page's notes editor. Agency-auth-gated.
 *
 * Body: { notes: string }
 *
 * Idempotent — same notes value can be PATCHed repeatedly without
 * side effects. Updated_at auto-bumps via the trigger added in 0008.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { LeadOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PatchBody = z.object({
  // Allow empty string (operator clearing the notes is valid).
  // Cap at 50k chars — even the most exhaustive strategist notes
  // shouldn't approach this; this is just a defensive ceiling.
  notes: z.string().max(50_000),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => i.message).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Verify the order exists + is an audit-tier order (the only ones
  // with a strategist workflow). Reject non-audit tiers gracefully.
  const { data: order } = await supabase
    .from('lead_orders')
    .select('id, tier, delivered_at')
    .eq('id', id)
    .maybeSingle<Pick<LeadOrderRow, 'id' | 'tier' | 'delivered_at'>>();

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }
  if (order.tier !== 'audit' && order.tier !== 'strategy') {
    return NextResponse.json(
      {
        error: `order tier "${order.tier}" doesn't support strategist notes`,
      },
      { status: 400 }
    );
  }
  if (order.delivered_at != null) {
    // Once delivered, lock the notes — re-edits would change history
    // and the buyer already received the PDF rendered from the prior
    // notes value. Operator can re-deliver if needed by un-stamping
    // delivered_at via SQL (intentionally not exposed in UI).
    return NextResponse.json(
      {
        error:
          'this order has been delivered — notes are locked. Reach out via SQL if a correction is needed.',
      },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from('lead_orders')
    .update({ strategist_notes: body.notes })
    .eq('id', id);

  if (error) {
    return NextResponse.json(
      { error: `update failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
