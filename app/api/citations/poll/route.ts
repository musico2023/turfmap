/**
 * POST /api/citations/poll — manual on-demand poll of one citation
 * order's status from BL.
 *
 * Mirrors what the hourly cron at /api/cron/poll-citations does, but
 * scoped to a single order_id and gated to agency users (no
 * CRON_SECRET). Wired to the "Poll now" button on the dashboard's
 * citations panel so operators don't have to wait up to an hour for
 * the next cron tick when they just want to see fresh status on a
 * campaign they're watching.
 *
 * Body: { order_id: <citation_orders.id UUID> }
 * Returns: { ok: true, status, perDirectoryCount } or { error }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { pollCitationOrder } from '@/lib/brightlocal/citationBuilder';
import type { CitationOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  order_id: z.string().uuid(),
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
    .select('id, brightlocal_order_id, maintenance_paused')
    .eq('id', parsed.order_id)
    .maybeSingle<
      Pick<CitationOrderRow, 'id' | 'brightlocal_order_id' | 'maintenance_paused'>
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
  if (!row.brightlocal_order_id) {
    return NextResponse.json(
      { error: 'order has no brightlocal_order_id — cannot poll' },
      { status: 400 }
    );
  }

  const result = await pollCitationOrder(row.brightlocal_order_id);
  if (!result.ok) {
    const status = result.kind === 'not_configured' ? 503 : 502;
    return NextResponse.json({ error: result.message, kind: result.kind }, { status });
  }

  const { error: updateErr } = await supabase
    .from('citation_orders')
    .update({
      status: result.status,
      per_directory: result.perDirectory,
      error: result.orderError,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (updateErr) {
    return NextResponse.json(
      { error: `update failed: ${updateErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    perDirectoryCount: result.perDirectory.length,
    orderError: result.orderError,
  });
}
