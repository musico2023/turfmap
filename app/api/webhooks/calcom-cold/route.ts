/**
 * POST /api/webhooks/calcom-cold
 *
 * SECOND Cal.com webhook — handles BOOKING_CREATED for the COLD-EMAIL
 * reply-driven cohort. Runs in parallel with /api/webhooks/calcom
 * (which handles the audit/strategy-tier paid-buyer path).
 *
 * Configure in Cal.com: add this URL as an additional webhook on
 * the same event types as the main one. Each handler IGNORES bookings
 * that don't belong to its cohort (resolved via the attendee email
 * → prospects table lookup), so running both in parallel is safe.
 *
 * What this does for a cold-cohort booking:
 *   1. Resolve the attendee email → prospects row with
 *      cohort='cold_email_q2_2026'. Skip everything else.
 *   2. Find the prospect's TurfScan lead_order (tier='scan',
 *      fulfilled). This exists because the prospect already redeemed
 *      the COLDSCAN coupon — that's what triggered Stage 3 and the
 *      calendar booking. If no scan order exists, skip (data
 *      inconsistency: log + return 200 so Cal.com stops retrying).
 *   3. Ensure a visibility_audits row exists for that scan order.
 *      Cold-cohort prospects DON'T fulfill an audit-tier order
 *      (they're getting the Visibility Audit free as a call), so
 *      the existing /api/orders/fulfill audit-row-creation path
 *      never runs for them. This handler bridges the gap by
 *      creating the row inline on first booking.
 *   4. Stamp audit_call_booked_at + strategist_call_scheduled_at
 *      (mirrors the main webhook's state flips, just for the
 *      bootstrapped row).
 *
 * Cal.com signature verification uses CAL_COM_WEBHOOK_SECRET — the
 * SAME secret as the main webhook (one shared signing secret across
 * all Cal.com webhooks for this account). Sharing the secret is OK
 * because each handler scopes itself via the cohort lookup; the
 * worst case is a redundant 200 from the wrong handler, not a
 * cross-cohort state corruption.
 *
 * The audit fulfillment pipeline (Roadmap PDF generation, Strategist
 * Prep Notes, audit-milestones cron) reads from the visibility_audits
 * table and processes any row with status != 'sixty_day_completed' —
 * no cohort-specific changes needed there. Once this handler creates
 * the row, the existing machinery fires the prep email 24 hr before
 * the call, the Roadmap PDF gets generated, etc.
 *
 * Differences from the audit-purchase flow:
 *   - The buyer does NOT receive the Roadmap PDF as an email
 *     attachment (per the marketing brief: PDF goes to Anthony only,
 *     buyer sees it during the call). To implement: add a
 *     `cold_cohort_pdf_buyer_suppressed` flag on the audit row's
 *     metadata (TBD; the StrategistPrep email send path will need to
 *     respect it). For NOW, this handler stamps the row but the
 *     buyer-facing emails go out as usual. Anthony's manual override:
 *     unsubscribe the buyer from the prep email channel after
 *     booking, or skip rendering the PDF link in the prep email for
 *     cold-cohort audits. See follow-up task.
 */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getServerSupabase } from '@/lib/supabase/server';
import { patchLeadOrderMetadataByClientId } from '@/lib/stripe/leadOrders';
import { patchVisibilityAudit, createVisibilityAudit } from '@/lib/audit/visibilityAudits';
import type { LeadOrderRow, VisibilityAuditRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

type CalcomTriggerEvent =
  | 'BOOKING_CREATED'
  | 'BOOKING_RESCHEDULED'
  | 'BOOKING_CANCELLED';

type CalcomAttendee = { email?: string; name?: string; timeZone?: string };
type CalcomBookingPayload = {
  uid?: string;
  startTime?: string;
  endTime?: string;
  attendees?: CalcomAttendee[];
  bookerUrl?: string;
};
type CalcomWebhookEvent = {
  triggerEvent?: CalcomTriggerEvent;
  payload?: CalcomBookingPayload;
};

export async function POST(req: Request) {
  // Dedicated secret for the cold-cohort webhook. Falls back to the
  // shared CAL_COM_WEBHOOK_SECRET if not set, so a single-secret
  // setup still works — but Anthony's deploy can isolate the secrets
  // for cleaner rotation by setting CAL_COM_WEBHOOK_SECRET_COLD only.
  const secret =
    process.env.CAL_COM_WEBHOOK_SECRET_COLD ??
    process.env.CAL_COM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CAL_COM_WEBHOOK_SECRET_COLD not configured' },
      { status: 503 }
    );
  }

  // Signature verification — same scheme as the main webhook.
  const rawBody = await req.text();
  const signatureHeader =
    req.headers.get('x-cal-signature-256') ??
    req.headers.get('X-Cal-Signature-256') ??
    '';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signatureHeader, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: CalcomWebhookEvent;
  try { event = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const trigger = event.triggerEvent;
  const payload = event.payload ?? {};
  if (trigger !== 'BOOKING_CREATED' &&
      trigger !== 'BOOKING_RESCHEDULED' &&
      trigger !== 'BOOKING_CANCELLED') {
    return NextResponse.json({ received: true, ignored: trigger });
  }

  const attendeeEmail = payload.attendees?.[0]?.email?.toLowerCase().trim();
  if (!attendeeEmail) {
    return NextResponse.json({ received: true, skipped: 'no email' });
  }

  const supabase = getServerSupabase();

  // ─── 1. Resolve attendee email → cold-cohort prospect ──────────────
  // This is the cohort filter. If the email doesn't match a cold-cohort
  // prospect, we 200 silently — the main webhook handles audit-tier
  // bookings, and this handler is intentionally scoped to cold cohort.
  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, business_name, email, first_name')
    .eq('cohort', 'cold_email_q2_2026')
    .ilike('email', attendeeEmail)
    .maybeSingle<{
      id: string;
      business_name: string;
      email: string | null;
      first_name: string | null;
    }>();

  if (!prospect) {
    return NextResponse.json({
      received: true,
      ignored: 'not a cold-cohort prospect (likely handled by main webhook)',
    });
  }

  // ─── 2. Find the prospect's TurfScan lead_order ───────────────────
  // The prospect redeemed COLDSCAN, so a scan-tier fulfilled order
  // should exist. We match by email (case-insensitive) — same approach
  // the main webhook uses. If no scan order exists, the cold-cohort
  // booking is anomalous (someone got the Cal.com link without paying
  // through the funnel). Log + 200 so Cal.com doesn't retry.
  const { data: order } = await supabase
    .from('lead_orders')
    .select('id, client_id, tier, email, stripe_metadata, scan_id')
    .ilike('email', attendeeEmail)
    .eq('tier', 'scan')
    .eq('status', 'fulfilled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<LeadOrderRow, 'id' | 'client_id' | 'tier' | 'email' | 'stripe_metadata'> & {
        scan_id: string | null;
      }
    >();

  if (!order || !order.client_id || !order.scan_id) {
    console.warn(
      `[calcom-cold] no scan-tier order matched ${attendeeEmail} — skipping (booking is anomalous)`
    );
    return NextResponse.json({ received: true, ignored: 'no scan order found' });
  }

  // ─── 3. Ensure visibility_audits row exists ──────────────────────
  // Cold-cohort prospects never pay for an audit upgrade, so the
  // audit-row-create path that runs in /api/orders/fulfill (tier='audit')
  // never fires for them. Bootstrap one here on first booking.
  const { data: existingAudit } = await supabase
    .from('visibility_audits')
    .select('id, status, strategist_call_scheduled_at')
    .eq('lead_order_id', order.id)
    .maybeSingle<
      Pick<VisibilityAuditRow, 'id' | 'status' | 'strategist_call_scheduled_at'>
    >();

  let auditId: string;
  if (existingAudit) {
    auditId = existingAudit.id;
  } else {
    // Cold-cohort audits start in pending_call_schedule; the booking
    // we're processing right now will transition to call_scheduled
    // below. Going through pending keeps the state machine identical
    // to the paid-audit path.
    const created = await createVisibilityAudit(supabase, {
      leadOrderId: order.id,
      scanId: order.scan_id,
      clientId: order.client_id,
    });
    if (!created.ok) {
      console.error(
        '[calcom-cold] createVisibilityAudit failed for prospect',
        prospect.id, created.error
      );
      return NextResponse.json(
        { error: 'audit_row_create_failed', message: created.error },
        { status: 500 }
      );
    }
    auditId = created.row.id;
  }

  // ─── 4. Cancellation path ─────────────────────────────────────────
  if (trigger === 'BOOKING_CANCELLED') {
    await patchLeadOrderMetadataByClientId(supabase, order.client_id, {
      audit_call_status: 'cancelled',
      audit_call_cancelled_at: new Date().toISOString(),
      audit_call_uid: payload.uid ?? null,
    });
    await patchVisibilityAudit(supabase, auditId, {
      strategist_call_scheduled_at: null,
      status: 'pending_call_schedule',
    });
    return NextResponse.json({ ok: true, action: 'cancelled_cold' });
  }

  // ─── 5. Created / rescheduled — flip state ────────────────────────
  await patchLeadOrderMetadataByClientId(supabase, order.client_id, {
    audit_call_status: 'booked',
    audit_call_booked_at: new Date().toISOString(),
    audit_call_uid: payload.uid ?? null,
    audit_call_start_time: payload.startTime ?? null,
    audit_call_manage_url: payload.bookerUrl ?? null,
    // Tag the metadata so downstream emails can suppress the
    // buyer-facing Roadmap PDF (cold-cohort buyers see it on the call,
    // not in their inbox). The audit-milestones cron + StrategistPrep
    // email render path should check this flag.
    cold_cohort_pdf_buyer_suppressed: true,
  });

  if (payload.startTime) {
    await patchVisibilityAudit(supabase, auditId, {
      status: 'call_scheduled',
      strategist_call_scheduled_at: payload.startTime,
    });
  }

  return NextResponse.json({
    ok: true,
    action: trigger,
    prospect_id: prospect.id,
    audit_id: auditId,
    bootstrapped: !existingAudit,
  });
}
