/**
 * Vercel Cron — citation-order status polling.
 *
 * Schedule (vercel.json): every 6 hours.
 *
 * For each citation_orders row in queued/in_progress state (and not
 * paused), polls BrightLocal for the latest per-directory status,
 * rewrites per_directory + status on the row, and stamps updated_at.
 *
 * No fan-out — citation orders typically resolve over 6-8 weeks, so
 * a 6-hour cadence is plenty. Vercel Cron will skip a tick if the
 * previous one is still running, so we don't worry about overlap.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — same pattern as the
 * weekly-scans cron. Vercel Cron sets this header automatically when
 * CRON_SECRET is configured.
 *
 * Returns: { polled, transitioned, errors }
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { pollCitationOrder } from '@/lib/brightlocal/citationBuilder';
import type { CitationOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Citation status polls are quick (~1-2s each via BL) but we may have
// 50+ open orders at scale. 5min ceiling is comfortable headroom.
export const maxDuration = 300;

export async function GET(req: Request) {
  // Auth gate — match the weekly-scans cron's pattern.
  const authHeader = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 503 }
    );
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();

  // Pull all open (non-paused, non-terminal) orders. Closed orders
  // (status complete/failed) don't change once terminal — no point
  // polling them. Maintenance-paused orders also skip (they keep
  // their existing per_directory snapshot frozen).
  const { data: openOrders, error: listErr } = await supabase
    .from('citation_orders')
    .select('id, brightlocal_order_id')
    .in('status', ['queued', 'in_progress'])
    .eq('maintenance_paused', false)
    .returns<Pick<CitationOrderRow, 'id' | 'brightlocal_order_id'>[]>();
  if (listErr) {
    return NextResponse.json(
      { error: `list failed: ${listErr.message}` },
      { status: 500 }
    );
  }
  const orders = openOrders ?? [];

  let transitioned = 0;
  const errors: Array<{ orderId: string; message: string }> = [];

  for (const row of orders) {
    if (!row.brightlocal_order_id) {
      // Should never happen — submit endpoint sets this immediately
      // — but guard so a malformed row doesn't take down the loop.
      errors.push({ orderId: row.id, message: 'missing brightlocal_order_id' });
      continue;
    }

    const result = await pollCitationOrder(row.brightlocal_order_id);
    if (!result.ok) {
      // 'not_configured' surfaces during the gated rollout window —
      // log + continue so the rest of the run still completes when
      // CITATION_BUILDER_ENABLED=false.
      if (result.kind !== 'not_configured') {
        errors.push({ orderId: row.id, message: result.message });
      }
      continue;
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
      errors.push({ orderId: row.id, message: `update failed: ${updateErr.message}` });
      continue;
    }
    transitioned += 1;
  }

  return NextResponse.json({
    polled: orders.length,
    transitioned,
    errors,
  });
}
