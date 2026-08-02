/**
 * GET /api/score/preview-status?submission_id=<uuid>
 *
 * Recovery poll for the free-score preview flow. `preview-init` holds
 * its HTTP response open for the full ~60s scan; on flaky mobile
 * connections that request can drop before the browser gets the
 * share_url — even though the scan completes server-side. The lander
 * form catches that drop and polls this endpoint with the same
 * client-generated submission_id it sent to preview-init, so it can
 * recover the finished share link and redirect the buyer in-session
 * (no "Load failed" dead end).
 *
 * Lookup chain: submission_id → preview lead_orders row → client_id →
 * most recent COMPLETE scan → scan_share_links. Returns:
 *   { status: 'ready', share_url } once the scan is done + shared
 *   { status: 'pending' }         while it's still running / not found yet
 *
 * Read-only, no auth: the only thing returned is a share_url, which is
 * already a public unguessable link. submission_id is a client uuid, so
 * this can't enumerate other buyers' scans.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const submissionId = new URL(req.url).searchParams
    .get('submission_id')
    ?.trim();
  if (!submissionId || submissionId.length > 120) {
    return NextResponse.json({ error: 'invalid submission_id' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // 1. submission_id → preview lead_orders row → client_id
  const { data: order } = await supabase
    .from('lead_orders')
    .select('client_id')
    .eq('stripe_metadata->>submission_id', submissionId)
    .maybeSingle<{ client_id: string | null }>();
  if (!order?.client_id) {
    // Scan hasn't reached the lead_orders insert yet (or never will).
    return NextResponse.json({ status: 'pending' });
  }

  // 2. client_id → most recent COMPLETE scan
  const { data: scan } = await supabase
    .from('scans')
    .select('id')
    .eq('client_id', order.client_id)
    .eq('status', 'complete')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!scan?.id) {
    return NextResponse.json({ status: 'pending' });
  }

  // 3. scan → share link
  const { data: share } = await supabase
    .from('scan_share_links')
    .select('id')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!share?.id) {
    return NextResponse.json({ status: 'pending' });
  }

  return NextResponse.json({
    status: 'ready',
    share_url: `/share/${share.id}`,
  });
}
