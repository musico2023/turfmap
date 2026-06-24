/**
 * Vercel Cron — citation-order status polling.
 *
 * Schedule (vercel.json): hourly. Citation orders typically resolve
 * over 6-8 weeks so the cadence is conservative, but going hourly
 * lets fresh submissions show progress within an hour rather than
 * up to a full day. Vercel Cron skips a tick if the previous one is
 * still running, so overlap isn't a concern.
 *
 * Operators who want immediate feedback can trigger a single-order
 * poll on demand via POST /api/citations/poll (agency-gated; no
 * CRON_SECRET required) — see the "Poll now" button in
 * components/turfmap/CitationsPanel.tsx.
 *
 * For each citation_orders row in queued/in_progress state (and not
 * paused) — plus any 'failed' row that still carries a BL campaign id, so
 * an order prematurely marked failed can heal once BL completes it —
 * polls BL for the latest per-directory status, rewrites per_directory +
 * status on the row, and stamps updated_at.
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

  // Pull open orders (queued/in_progress) PLUS recovery candidates:
  // orders stuck on 'failed' that nonetheless carry a BL campaign id.
  //
  // Why recover 'failed': our create→confirm flow can stamp status='failed'
  // *after* BrightLocal already created the campaign (e.g. our checkout step
  // errored, then the campaign was paid/completed manually in the BL
  // dashboard). Because 'failed' is terminal, such an order would never
  // heal — the dashboard shows a phantom failure for a campaign that's
  // actually live (this happened to Sugar Daddy Doughnuts / BL 965489).
  // Re-checking failed-with-id orders lets BrightLocal's source of truth
  // pull them back to complete/in_progress. Failed orders with NO campaign
  // id are excluded — there's nothing to poll. Maintenance-paused orders
  // skip (their per_directory snapshot stays frozen).
  const { data: openOrders, error: listErr } = await supabase
    .from('citation_orders')
    .select('id, brightlocal_order_id, status')
    .or(
      'status.in.(queued,in_progress),and(status.eq.failed,brightlocal_order_id.not.is.null)'
    )
    .eq('maintenance_paused', false)
    .returns<Pick<CitationOrderRow, 'id' | 'brightlocal_order_id' | 'status'>[]>();
  if (listErr) {
    return NextResponse.json(
      { error: `list failed: ${listErr.message}` },
      { status: 500 }
    );
  }
  const orders = openOrders ?? [];

  let transitioned = 0;
  let recovered = 0;
  const errors: Array<{ orderId: string; message: string }> = [];

  for (const row of orders) {
    if (!row.brightlocal_order_id) {
      // Should never happen — submit endpoint sets this immediately
      // — but guard so a malformed row doesn't take down the loop.
      errors.push({ orderId: row.id, message: 'missing brightlocal_order_id' });
      continue;
    }

    const isRecoveryCandidate = row.status === 'failed';
    const result = await pollCitationOrder(row.brightlocal_order_id);
    if (!result.ok) {
      // For a recovery candidate, a not_found just means BL has no campaign
      // for this id (a genuinely-dead order) — leave it failed, no error
      // spam each run.
      if (result.kind === 'not_found' && isRecoveryCandidate) continue;
      // 'not_configured' surfaces during the gated rollout window —
      // log + continue so the rest of the run still completes when
      // CITATION_BUILDER_ENABLED=false.
      if (result.kind !== 'not_configured') {
        errors.push({ orderId: row.id, message: result.message });
      }
      continue;
    }
    if (isRecoveryCandidate) recovered += 1;

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
    recovered,
    errors,
  });
}
