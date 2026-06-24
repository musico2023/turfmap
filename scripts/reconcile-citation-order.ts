/**
 * One-off: reconcile a single citation_orders row against BrightLocal.
 *
 * Why: an order can diverge from BL's source of truth — e.g. our
 * create→confirm flow errored and stamped status='failed', then the
 * campaign was paid/completed manually in the BL dashboard. The hourly
 * poll-citations cron only polls queued/in_progress rows, so a 'failed'
 * row never recovers even though BL actually finished the work.
 *
 * This re-fetches via our own pollCitationOrder() (so per_directory +
 * status land in exactly the shape the dashboard expects) and rewrites
 * the row regardless of its current terminal state.
 *
 * Usage (key passed via env, never written to disk):
 *   BRIGHTLOCAL_API_KEY=… CITATION_BUILDER_ENABLED=true \
 *     tsx scripts/reconcile-citation-order.ts <citation_orders.id>
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { pollCitationOrder } from '../lib/brightlocal/citationBuilder';

async function main() {
  const orderRowId = process.argv[2];
  if (!orderRowId) {
    console.error('usage: tsx scripts/reconcile-citation-order.ts <citation_orders.id>');
    process.exit(1);
  }

  const supabase = getServerSupabase();
  const { data: row, error: readErr } = await supabase
    .from('citation_orders')
    .select('id, brightlocal_order_id, status')
    .eq('id', orderRowId)
    .maybeSingle<{ id: string; brightlocal_order_id: string | null; status: string }>();
  if (readErr || !row) {
    console.error('order not found:', readErr?.message ?? orderRowId);
    process.exit(1);
  }
  if (!row.brightlocal_order_id) {
    console.error('order has no brightlocal_order_id — nothing to reconcile');
    process.exit(1);
  }
  console.log(`before: status=${row.status} bl_order=${row.brightlocal_order_id}`);

  const result = await pollCitationOrder(row.brightlocal_order_id);
  if (!result.ok) {
    console.error('BL poll failed:', result.kind, '-', result.message);
    process.exit(1);
  }

  const live = result.perDirectory.filter((d) => d.status === 'live').length;
  const submitted = result.perDirectory.filter((d) => d.status === 'submitted').length;
  const pending = result.perDirectory.filter((d) => d.status === 'pending').length;
  console.log(
    `BL truth: status=${result.status} | ${result.perDirectory.length} directories ` +
      `(live=${live}, submitted=${submitted}, pending=${pending})`
  );

  const { error: updErr } = await supabase
    .from('citation_orders')
    .update({
      status: result.status,
      per_directory: result.perDirectory,
      error: result.orderError,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (updErr) {
    console.error('update failed:', updErr.message);
    process.exit(1);
  }
  console.log(`after: status=${result.status} ✓ reconciled`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
