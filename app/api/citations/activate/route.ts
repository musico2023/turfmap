/**
 * POST /api/citations/activate — operator confirms a GHL Listings order
 * is live.
 *
 * GHL exposes no public API for the "enable Listings on a sub-account"
 * toggle (verified against the v2 docs, 2026-07-11), so activation is a
 * manual click in the GHL agency dashboard. This endpoint is how the
 * operator tells TurfMap that click happened: it flips the order from
 * 'awaiting_activation' to 'active', which switches the client-facing
 * citations panel to "syncing" state. Wired to the "Mark activated"
 * button on the dashboard citations panel; agency-gated like
 * /api/citations/poll.
 *
 * Optionally accepts ghl_location_id — when API provisioning was
 * plan-gated the sub-account was created manually and we don't know its
 * id until the operator pastes it (used for the deep link on the panel;
 * not required to activate).
 *
 * Body: { order_id: <citation_orders.id UUID>, ghl_location_id?: string }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { CitationOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 15;

const Body = z.object({
  order_id: z.string().uuid(),
  ghl_location_id: z.string().min(1).max(120).nullish(),
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
        { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { data: row, error: lookupErr } = await supabase
    .from('citation_orders')
    .select('id, provider, status, ghl_location_id')
    .eq('id', parsed.order_id)
    .maybeSingle<
      Pick<CitationOrderRow, 'id' | 'provider' | 'status' | 'ghl_location_id'>
    >();
  if (lookupErr) {
    return NextResponse.json(
      { error: `lookup failed: ${lookupErr.message}` },
      { status: 500 }
    );
  }
  if (!row) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }
  if (row.provider !== 'ghl_listings') {
    return NextResponse.json(
      { error: 'activation only applies to GHL Listings orders' },
      { status: 400 }
    );
  }
  if (row.status !== 'awaiting_activation') {
    // Idempotent-friendly: re-clicking on an already-active order is a
    // no-op success, anything else is a real state error.
    if (row.status === 'active') return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: `order is '${row.status}', not awaiting_activation` },
      { status: 409 }
    );
  }

  const update: Record<string, unknown> = {
    status: 'active',
    error: null,
    updated_at: new Date().toISOString(),
  };
  if (parsed.ghl_location_id && !row.ghl_location_id) {
    update.ghl_location_id = parsed.ghl_location_id;
  }
  const { error: updateErr } = await supabase
    .from('citation_orders')
    .update(update)
    .eq('id', parsed.order_id);
  if (updateErr) {
    return NextResponse.json(
      { error: `update failed: ${updateErr.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
