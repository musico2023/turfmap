/**
 * POST /api/webhooks/calcom
 *
 * Cal.com webhook ingestion. Receives BOOKING_CREATED, _RESCHEDULED,
 * and _CANCELLED events for audit-tier strategist calls and:
 *
 *   1. Verifies the request signature using CAL_COM_WEBHOOK_SECRET
 *      (HMAC-SHA256 over the raw body, sent in `x-cal-signature-256`
 *      per Cal.com's docs). Without verification anyone could POST
 *      a fake booking and trigger the confirmation email + state
 *      flip; with verification only Cal.com's signed payloads pass.
 *
 *   2. Resolves the buyer's lead_orders row from the booking
 *      attendee email (Cal.com gives us the email the buyer used
 *      when they booked, which matches the email on the original
 *      Stripe checkout session for our flow). The lead_orders
 *      lookup also confirms the buyer is on an audit/strategy tier
 *      — we ignore Cal.com bookings that aren't tied to an
 *      audit-fulfilled order (e.g. someone manually booked the
 *      Cal.com link without paying).
 *
 *   3. Patches the lead_orders row's stripe_metadata: flips
 *      audit_call_status from 'unbooked' → 'booked' (or 'cancelled'),
 *      stamps audit_call_booked_at / audit_call_cancelled_at
 *      timestamps. This stops the audit-call-reminders cron from
 *      sending a redundant reminder.
 *
 *   4. Sends the AuditCallConfirmedEmail with the locked-in time so
 *      the buyer has a TurfMap-branded follow-up alongside Cal.com's
 *      auto-generated calendar invite.
 *
 * Idempotency: Cal.com retries failed deliveries up to 5 times. The
 * metadata patch is a write-then-merge so retried events converge
 * to the same row state. The confirmation email checks
 * audit_call_status BEFORE sending — if already 'booked', we skip
 * the email send (re-deliveries happen; the buyer should not get
 * the same confirmation twice).
 *
 * Required env:
 *   CAL_COM_WEBHOOK_SECRET — set this exact value as the
 *                            "Secret" field when creating the
 *                            webhook in Cal.com → Settings →
 *                            Developer → Webhooks.
 *   RESEND_API_KEY         — for the confirmation email.
 */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getServerSupabase } from '@/lib/supabase/server';
import { patchLeadOrderMetadataByClientId } from '@/lib/stripe/leadOrders';
import { sendAuditCallConfirmed, cancelScheduledEmail } from '@/lib/email/resend';
import type { ClientRow, LeadOrderRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

type CalcomTriggerEvent =
  | 'BOOKING_CREATED'
  | 'BOOKING_RESCHEDULED'
  | 'BOOKING_CANCELLED';

type CalcomAttendee = {
  email?: string;
  name?: string;
  timeZone?: string;
};

type CalcomBookingPayload = {
  uid?: string;
  startTime?: string; // ISO 8601
  endTime?: string;
  title?: string;
  bookerUrl?: string; // Cal.com cancellation/reschedule URL
  rescheduleUid?: string;
  attendees?: CalcomAttendee[];
  organizer?: { timeZone?: string };
};

type CalcomWebhookEvent = {
  triggerEvent?: CalcomTriggerEvent;
  payload?: CalcomBookingPayload;
};

export async function POST(req: Request) {
  const secret = process.env.CAL_COM_WEBHOOK_SECRET;
  if (!secret) {
    // No secret set means we can't verify signatures — refuse to
    // process anything. Returning 503 (not 500) tells Cal.com to
    // retry later; if the operator is mid-rotation we don't want
    // to hard-fail the queue.
    return NextResponse.json(
      { error: 'CAL_COM_WEBHOOK_SECRET not configured' },
      { status: 503 }
    );
  }

  // Read raw body once — needed for both signature verification and
  // payload parsing. Cal.com signs the raw body bytes, so reading
  // via req.json() first would leave us unable to verify.
  const rawBody = await req.text();
  const signatureHeader =
    req.headers.get('x-cal-signature-256') ??
    req.headers.get('X-Cal-Signature-256') ??
    '';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time compare. timingSafeEqual throws on length
  // mismatch, so guard with a string-length check first.
  const sigBuf = Buffer.from(signatureHeader, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    return NextResponse.json(
      { error: 'invalid signature' },
      { status: 401 }
    );
  }

  let event: CalcomWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON body' },
      { status: 400 }
    );
  }

  const trigger = event.triggerEvent;
  const payload = event.payload ?? {};

  // We only care about three trigger types. Any other event (e.g.
  // BOOKING_CONFIRMED for double-confirmation flows we don't use,
  // BOOKING_REQUESTED for approval-required event types) gets a
  // 200 with no action — Cal.com will stop retrying.
  if (
    trigger !== 'BOOKING_CREATED' &&
    trigger !== 'BOOKING_RESCHEDULED' &&
    trigger !== 'BOOKING_CANCELLED'
  ) {
    return NextResponse.json({ received: true, ignored: trigger });
  }

  const attendeeEmail = payload.attendees?.[0]?.email?.toLowerCase().trim();
  if (!attendeeEmail) {
    console.warn('[calcom-webhook] no attendee email on payload', {
      trigger,
    });
    return NextResponse.json({ received: true, skipped: 'no email' });
  }

  // Resolve the buyer's most recent audit/strategy lead_orders row.
  // Match by email (case-insensitive). We could match by the
  // booking's `metadata` if Cal.com let us pre-fill it, but their
  // pre-fill mechanism doesn't currently round-trip metadata — so
  // email it is.
  const supabase = getServerSupabase();
  const { data: order } = await supabase
    .from('lead_orders')
    .select('id, client_id, tier, email, stripe_metadata')
    .ilike('email', attendeeEmail)
    .in('tier', ['audit', 'strategy'])
    .eq('status', 'fulfilled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<
        LeadOrderRow,
        'id' | 'client_id' | 'tier' | 'email' | 'stripe_metadata'
      >
    >();

  if (!order || !order.client_id) {
    console.warn(
      `[calcom-webhook] no audit/strategy order matched email ${attendeeEmail} for ${trigger} — ignoring`
    );
    return NextResponse.json({
      received: true,
      ignored: 'no matching order',
    });
  }

  const existingMeta =
    (order.stripe_metadata as Record<string, unknown> | null) ?? {};
  const existingStatus = existingMeta.audit_call_status;
  const reminderEmailId =
    typeof existingMeta.audit_reminder_email_id === 'string'
      ? (existingMeta.audit_reminder_email_id as string)
      : null;

  // If a queued audit-call reminder is sitting in Resend's scheduled
  // queue, cancel it. The reminder is a 20-min nudge for buyers who
  // haven't booked yet — once the booking lands (created or
  // cancelled), that nudge becomes either redundant (created) or
  // misleading (cancelled), so kill it either way. cancelScheduledEmail
  // returns true on already-sent / already-cancelled, so this is
  // idempotent across Cal.com's retried webhook deliveries.
  if (reminderEmailId) {
    try {
      await cancelScheduledEmail(reminderEmailId);
    } catch (e) {
      // Don't 500 — the state flip below is the load-bearing piece.
      // Worst case the buyer gets one stale reminder; not a regression
      // from the previous (cron-based) world.
      console.error(
        '[calcom-webhook] cancelScheduledEmail threw',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // Cancellation path: flip status, clear booked_at if any, no
  // email (Cal.com sends a cancellation notice itself; doubling up
  // would be noise).
  if (trigger === 'BOOKING_CANCELLED') {
    await patchLeadOrderMetadataByClientId(supabase, order.client_id, {
      audit_call_status: 'cancelled',
      audit_call_cancelled_at: new Date().toISOString(),
      audit_call_uid: payload.uid ?? null,
      // Clear the reminder ID — the email has been cancelled (or
      // never existed), so no future cancel is needed.
      audit_reminder_email_id: null,
    });
    return NextResponse.json({ ok: true, action: 'cancelled' });
  }

  // Created or rescheduled. Both flip to 'booked' and stamp the new
  // booked_at timestamp. We send the confirmation email on
  // BOOKING_CREATED only — reschedules already trigger Cal.com's
  // own "your booking has been rescheduled" email, so a second
  // TurfMap-branded one would be redundant noise.
  await patchLeadOrderMetadataByClientId(supabase, order.client_id, {
    audit_call_status: 'booked',
    audit_call_booked_at: new Date().toISOString(),
    audit_call_uid: payload.uid ?? null,
    audit_call_start_time: payload.startTime ?? null,
    audit_call_manage_url: payload.bookerUrl ?? null,
    // Clear the reminder ID — we just cancelled the queued send (if
    // any). Stale ID lying around could confuse a future operator.
    audit_reminder_email_id: null,
  });

  // Skip the confirmation email if we've already sent one — Cal.com
  // delivers BOOKING_CREATED at-least-once, and a refreshed delivery
  // shouldn't blast the same email at the buyer twice.
  if (trigger === 'BOOKING_CREATED' && existingStatus !== 'booked') {
    // Resolve the client's business_name + public_id for the email
    // body. We re-query rather than caching to keep the webhook
    // handler resilient to stale joins.
    const { data: client } = await supabase
      .from('clients')
      .select('business_name, public_id')
      .eq('id', order.client_id)
      .maybeSingle<Pick<ClientRow, 'business_name' | 'public_id'>>();

    if (client) {
      const origin =
        process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
      const dashboardUrl = `${origin}/portal/${client.public_id}`;
      const scheduledAt = formatScheduledAt(
        payload.startTime,
        payload.attendees?.[0]?.timeZone
      );
      const manageUrl =
        payload.bookerUrl ?? 'https://cal.com/bookings/upcoming';
      try {
        await sendAuditCallConfirmed({
          to: order.email ?? attendeeEmail,
          businessName: client.business_name,
          scheduledAt,
          manageBookingUrl: manageUrl,
          dashboardUrl,
        });
      } catch (e) {
        // Don't 500 — Cal.com would retry the whole webhook + we'd
        // double-stamp the metadata. The state flip already
        // succeeded; email failure is recoverable async.
        console.error(
          '[calcom-webhook] sendAuditCallConfirmed failed',
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }

  return NextResponse.json({ ok: true, action: trigger });
}

/**
 * Format Cal.com's ISO startTime + the booker's timezone into the
 * human string the email expects ("Tuesday, Aug 12 at 2:00 pm EDT").
 * Falls back to the raw ISO if Intl barfs on the inputs (rare; only
 * if the timezone string is malformed).
 */
function formatScheduledAt(
  startTimeIso: string | undefined,
  timeZone: string | undefined
): string {
  if (!startTimeIso) return 'your scheduled time';
  try {
    const d = new Date(startTimeIso);
    const tz = timeZone || 'America/New_York';
    const datePart = d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    });
    const timePart = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: tz,
    });
    return `${datePart} at ${timePart}`;
  } catch {
    return startTimeIso;
  }
}
