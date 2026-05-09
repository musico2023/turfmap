/**
 * Vercel Cron — audit-call booking reminders.
 *
 * Schedule (vercel.json): every 5 minutes. Sweeps the lead_orders
 * table for audit/strategy buyers who haven't booked their Cal.com
 * strategist call yet AND whose order is at least 20 minutes old.
 * Sends a single AuditCallReminderEmail per buyer, then stamps
 * audit_call_reminded_at on the row so the next sweep doesn't
 * re-send.
 *
 * State machine (stored in lead_orders.stripe_metadata):
 *
 *   'unbooked' (initial)
 *      ↓ Cal.com BOOKING_CREATED webhook
 *   'booked'   → terminal (cron skips)
 *
 *   'unbooked' (initial) + age > 20m + reminded_at IS NULL
 *      ↓ this cron, single email
 *   'unbooked' + reminded_at = now()
 *
 *   'unbooked' + reminded_at NOT NULL → terminal (no second
 *      reminder; we don't nag past day 0). If the buyer never books,
 *      operator picks them up via the agency dashboard's pending-
 *      orders view.
 *
 * Why a cron + state in metadata vs. an inline setTimeout / queue:
 *   - Vercel functions can't reliably hold a 20-min delay (function
 *     timeouts cap at 300s; Queues are still beta).
 *   - The cron is at-least-once safe because reminded_at acts as
 *     the dedupe gate.
 *   - State in JSONB metadata avoids a schema migration + keeps
 *     audit-call lifecycle co-located with the order it belongs to.
 *
 * Auth: Bearer CRON_SECRET (same pattern as the other crons in
 * this directory).
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { patchLeadOrderMetadataByClientId } from '@/lib/stripe/leadOrders';
import { calcomBookingUrlForTier } from '@/lib/integrations/calcom';
import { sendAuditCallReminder } from '@/lib/email/resend';
import type { ClientRow, LeadOrderRow, Tier } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Minimum age of an unbooked audit order before we send the
 *  reminder. 20 minutes hits the sweet spot — long enough that the
 *  buyer wasn't just briefly distracted, short enough that the
 *  audit purchase is still top-of-mind. */
const REMINDER_DELAY_MS = 20 * 60 * 1000;

/** Outer bound on the sweep window. Orders older than this are
 *  already in the "operator follow-up" zone; the automated reminder
 *  has nothing useful left to add. Keeps the cron's working set
 *  bounded as the lead_orders table grows. */
const REMINDER_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
  const now = Date.now();
  const windowStart = new Date(now - REMINDER_LOOKBACK_MS).toISOString();
  const reminderCutoff = new Date(now - REMINDER_DELAY_MS).toISOString();

  // Pull candidate audit/strategy orders. We can't filter on JSONB
  // contents efficiently in supabase-js without a custom RPC, so we
  // pull all fulfilled audit/strategy orders within the window and
  // filter in code. The lookback bound keeps the working set
  // bounded even as the table grows — at expected volume (low
  // hundreds of audit orders/year) this is well under 1k rows per
  // sweep.
  const { data: candidates, error } = await supabase
    .from('lead_orders')
    .select('id, client_id, tier, email, stripe_metadata, created_at')
    .in('tier', ['audit', 'strategy'])
    .eq('status', 'fulfilled')
    .gte('created_at', windowStart)
    .lt('created_at', reminderCutoff)
    .not('client_id', 'is', null)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[audit-reminders] candidate select failed', error);
    return NextResponse.json(
      { error: `query failed: ${error.message}` },
      { status: 500 }
    );
  }

  const rows = (candidates ?? []) as Pick<
    LeadOrderRow,
    'id' | 'client_id' | 'tier' | 'email' | 'stripe_metadata' | 'created_at'
  >[];

  let sent = 0;
  let skipped = 0;
  const failures: Array<{ orderId: string; reason: string }> = [];

  for (const row of rows) {
    const meta =
      (row.stripe_metadata as Record<string, unknown> | null) ?? {};
    const status = meta.audit_call_status as string | undefined;
    const reminded = meta.audit_call_reminded_at;

    // Skip terminal states + already-reminded.
    if (status === 'booked' || status === 'cancelled') {
      skipped++;
      continue;
    }
    if (reminded) {
      skipped++;
      continue;
    }
    // If status is missing entirely (legacy orders pre-stamp), skip
    // — the cron is for new orders that went through the audit-
    // call lifecycle. Operators handle pre-stamp orders manually.
    if (status !== 'unbooked') {
      skipped++;
      continue;
    }
    if (!row.email || !row.client_id) {
      skipped++;
      continue;
    }

    // Resolve the client for businessName + a fresh Cal.com URL.
    const { data: client } = await supabase
      .from('clients')
      .select('business_name')
      .eq('id', row.client_id)
      .maybeSingle<Pick<ClientRow, 'business_name'>>();
    if (!client) {
      failures.push({ orderId: row.id, reason: 'client not found' });
      continue;
    }

    const bookingUrl = calcomBookingUrlForTier({
      tier: row.tier as Tier,
      email: row.email,
      businessName: client.business_name,
    });
    if (!bookingUrl) {
      // CAL_COM_*_URL env not set — can't build a usable link, so
      // the reminder would point at nothing. Skip + log so the
      // operator notices.
      failures.push({
        orderId: row.id,
        reason: 'CAL_COM_*_URL not configured',
      });
      continue;
    }

    // Stamp the metadata FIRST, then send the email. This ordering
    // matters: if the email send retries (Resend transient blip)
    // and the cron runs again, the reminded_at marker prevents
    // double-sends. A failed email send is recoverable; a
    // duplicated email is not.
    const stamped = await patchLeadOrderMetadataByClientId(
      supabase,
      row.client_id,
      { audit_call_reminded_at: new Date().toISOString() }
    );
    if (!stamped.ok) {
      failures.push({
        orderId: row.id,
        reason: `metadata stamp failed: ${stamped.error}`,
      });
      continue;
    }

    try {
      const ok = await sendAuditCallReminder({
        to: row.email,
        businessName: client.business_name,
        bookingUrl,
      });
      if (ok) {
        sent++;
      } else {
        failures.push({
          orderId: row.id,
          reason: 'sendAuditCallReminder returned false',
        });
      }
    } catch (e) {
      failures.push({
        orderId: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    candidates: rows.length,
    sent,
    skipped,
    failures,
  });
}
