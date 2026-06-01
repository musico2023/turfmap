/**
 * Vercel Cron — garbage-collect unconverted /score preview clients.
 *
 * Schedule (vercel.json): daily at 04:00 UTC (~midnight Eastern,
 * off-peak). Pairs the GC sweep with the lowest-traffic window so
 * any incidentally-running queries don't fight the operator
 * dashboards.
 *
 * What it deletes:
 *
 *   1. clients with is_preview=true older than 30 days.
 *      ON DELETE CASCADE on client_locations, tracked_keywords,
 *      scans, scan_share_links, lead_orders (where applicable —
 *      check the migration for cascade specifics) takes the rest.
 *
 *   2. score_preview_throttle rows older than 7 days.
 *      Kept short — the throttle's only purpose is the 24h-day
 *      bucket, so anything older is debug-only noise.
 *
 * Why 30 days for previews: a /score visitor who hasn't unlocked
 * in 30 days is highly unlikely to ever pay. Holding their preview
 * scan + share link longer is dead storage. If they come back
 * after the GC, they can run a fresh preview (the throttle reset
 * by then anyway).
 *
 * Conservative deletes: we explicitly require is_preview=true on
 * the WHERE clause so a future code-path that flips a preview's
 * is_preview to true erroneously doesn't get caught in the sweep
 * because of a stale created_at.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} — Vercel Cron sets
 * this automatically. Manual invocation requires the same header.
 *
 * Silent success: when no rows match, the response is { ok: true,
 * previewClientsDeleted: 0, throttleRowsDeleted: 0 } — no Slack
 * ping. Operator visibility comes from Vercel cron logs.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const PREVIEW_TTL_DAYS = 30;
  const THROTTLE_TTL_DAYS = 7;

  // ─── 1. Delete preview clients older than 30 days ──────────────────
  // Use the partial index `clients_active_only_idx` is_preview=false;
  // this query intentionally scans the small `is_preview=true` subset
  // (which is bounded — most rows in the lifetime of the funnel are
  // converted or GC'd already).
  const previewCutoff = new Date(
    Date.now() - PREVIEW_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: deletedPreviews, error: prevErr } = await supabase
    .from('clients')
    .delete()
    .eq('is_preview', true)
    .lt('created_at', previewCutoff)
    .select('id');
  if (prevErr) {
    console.error(
      '[gc-preview-clients] preview client delete failed:',
      prevErr.message
    );
    return NextResponse.json(
      { error: `preview delete failed: ${prevErr.message}` },
      { status: 500 }
    );
  }
  const previewClientsDeleted = deletedPreviews?.length ?? 0;

  // ─── 2. Delete throttle rows older than 7 days ─────────────────────
  const throttleCutoff = new Date(
    Date.now() - THROTTLE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: deletedThrottle, error: throttleErr } = await supabase
    .from('score_preview_throttle')
    .delete()
    .lt('created_at', throttleCutoff)
    .select('id');
  if (throttleErr) {
    console.error(
      '[gc-preview-clients] throttle delete failed:',
      throttleErr.message
    );
    // Don't fail the route — the throttle GC is non-critical.
  }
  const throttleRowsDeleted = deletedThrottle?.length ?? 0;

  return NextResponse.json({
    ok: true,
    previewClientsDeleted,
    throttleRowsDeleted,
    previewCutoff,
    throttleCutoff,
  });
}
