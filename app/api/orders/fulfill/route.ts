/**
 * POST /api/orders/fulfill
 *
 * Self-serve order completion endpoint. Called by the OrderSuccessForm
 * after a buyer fills in business details on /order/success following
 * a successful Stripe Checkout. This is the critical path for the
 * marketing tripwire.
 *
 * Flow:
 *   1. Validate the request body (Zod).
 *   2. Re-validate the Stripe session (defense in depth — never trust
 *      client-provided session_id alone).
 *   3. Confirm the lead_orders row exists + is still 'pending'.
 *   4. Geocode the submitted address.
 *   5. Insert the clients row, with billing_mode + stripe IDs derived
 *      from the tier. Best-effort transactional rollback on failure.
 *   6. Insert the primary client_locations row.
 *   7. Insert N tracked_keywords rows (1 for scan/audit/pulse, 3 for
 *      strategy/pulse_plus).
 *   8. Trigger the first scan synchronously so the success state can
 *      return scan_id. For multi-keyword tiers, additional scans are
 *      fired in parallel and we wait for all of them to complete
 *      before returning. Cron picks up future scheduled scans.
 *   9. Mark the lead_orders row as fulfilled with the client_id.
 *  10. (Future, §4) Queue the "Your TurfMap is ready" email via Resend.
 *
 * Idempotency: lead_orders.status='fulfilled' check at step 3 prevents
 * double-fulfillment if the buyer hits submit twice. The whole route
 * is safe to retry after partial failure — the rollback path on each
 * insert deletes the half-written client row.
 *
 * Pre-Stripe-launch state: returns 503 with a helpful inline error
 * envelope if STRIPE_SECRET_KEY isn't configured. Same graceful
 * degradation pattern as /api/checkout/[tier].
 */

import { NextResponse, after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { geocodeAddress } from '@/lib/geocoding/nominatim';
import { runScanForLocation } from '@/lib/scans/runScan';
import {
  loadCheckoutSession,
  type LoadSessionError,
} from '@/lib/stripe/session';
import {
  billingModeForTier,
  getLeadOrderBySessionId,
  keywordCountForTier,
  markLeadOrderFailed,
  markLeadOrderFulfilled,
  patchLeadOrderMetadataByClientId,
} from '@/lib/stripe/leadOrders';
import { STRIPE_NOT_CONFIGURED_ERROR } from '@/lib/stripe/client';
import {
  sendOrderConfirmation,
  sendScanReady,
  sendPulsePlusWelcome,
  sendAuditCallReminder,
  sendAuditPurchaseRoadmap,
} from '@/lib/email/resend';
import { generateAndStoreRoadmapPdf } from '@/lib/audit/generateAndStoreRoadmapPdf';

/** Operator inbox for audit-tier deliverables. Mirrors the same
 *  constant used by app/api/cron/audit-milestones — both surfaces
 *  ship audit artifacts here so the strategist (Anthony) has the
 *  PDF + prep notes in hand before any buyer touchpoint. */
const OPERATOR_AUDIT_EMAIL = 'anthony@fourdots.io';
import { calcomBookingUrlForTier } from '@/lib/integrations/calcom';
import { enrichLocationFromOnboarding } from '@/lib/google/enrich';
import { computeLlmFitScore, LLM_TARGET_TRADES, type LlmTargetTrade, shouldPitchLlm } from '@/lib/audit/llmFitScore';
import { createVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { triggerNapAuditAtAuditInit } from '@/lib/audit/triggerNapAuditAtAuditInit';
import { ensurePortalUser } from '@/lib/auth/ensurePortalUser';
import {
  notifyLlmFitAudit,
  notifyTurfScanPurchase,
} from '@/lib/audit/operatorSlack';
import type {
  ClientLocationRow,
  ClientRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Strategy tier runs 3 scans in parallel. Each ~30s typical, occasional
// 60s+ tail. 300s ceiling gives us comfortable headroom even when one
// keyword's DFS request hits a retry.
export const maxDuration = 300;

const FulfillBody = z.object({
  sessionId: z.string().min(8),
  // Tier comes back from the page as a sanity check, but we re-derive
  // it from the Stripe session below — never trust the client.
  tier: z.string().optional(),
  businessName: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
  keywords: z.array(z.string().min(2).max(160)).min(1).max(3),
  email: z.string().email(),
  // Phone is the P in NAP — required for the citation check across
  // directories. locationToBusinessProfile() returns null without it
  // and the BrightLocal NAP audit short-circuits. min(7) accepts the
  // shortest plausible international form (e.g. "+1 416 5"); the
  // form's tel input does the heavy lifting on local format.
  phone: z.string().min(7).max(40),
  // Optional Mapbox-picked geo. When BOTH lat and lng are present,
  // fulfill USES them directly and skips Nominatim — prevents wrong-
  // city matches for ambiguously-named streets (Hendricks / Meadowview
  // 2026-05-19 class of bug). Free-text addresses (no Mapbox pick)
  // omit these and fall back to Nominatim with whatever structured
  // hints `components` carries.
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  components: z
    .object({
      street_address: z.string().nullish(),
      city: z.string().nullish(),
      region: z.string().nullish(),
      postcode: z.string().nullish(),
      country_code: z.string().nullish(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof FulfillBody>;
  try {
    body = FulfillBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  // ─── 1. Stripe session validation ─────────────────────────────────────
  // Re-fetches the session and confirms tier metadata + paid status.
  // This is the only source of truth for "what did they buy?" — the
  // tier value the client posts is a hint, not authority.
  const session = await loadCheckoutSession(body.sessionId);
  if ('kind' in session) {
    return errorForLoadSession(session);
  }

  // Validate keyword count matches what the tier expects. Strategy
  // sends 3, others send 1. A mismatch here means either the form
  // shipped wrong code or an attacker is poking at the endpoint.
  const expectedKeywordCount = keywordCountForTier(session.tier);
  if (body.keywords.length !== expectedKeywordCount) {
    return NextResponse.json(
      {
        error: `tier "${session.tier}" expects ${expectedKeywordCount} keyword(s); got ${body.keywords.length}`,
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // ─── 2. lead_orders idempotency check ─────────────────────────────────
  const lead = await getLeadOrderBySessionId(supabase, body.sessionId);
  if (!lead) {
    // Unusual — /order/success should have created the row on first
    // load. Could happen if the buyer somehow hit /api/orders/fulfill
    // directly without visiting the success page. Insert one now so
    // we still have an audit trail.
    return NextResponse.json(
      {
        error:
          "Order session not found in our records. Email support@turfmap.ai with your Stripe session id and we'll fire your scan manually.",
      },
      { status: 404 }
    );
  }

  if (lead.status === 'fulfilled') {
    // Buyer hit /order/success again — likely refresh, return-from-tab,
    // or wizard resume. Look up the client so we can hand back the
    // public_id + current onboarding_step; the frontend uses these to
    // re-mount the success state (or resume the wizard at the right
    // step) without forcing a re-fulfill.
    let publicId: string | null = null;
    let onboardingStep: string | null = null;
    if (lead.client_id) {
      const { data: c } = await supabase
        .from('clients')
        .select('public_id, onboarding_step')
        .eq('id', lead.client_id)
        .maybeSingle<Pick<ClientRow, 'public_id' | 'onboarding_step'>>();
      publicId = c?.public_id ?? null;
      onboardingStep = c?.onboarding_step ?? null;
    }
    return NextResponse.json(
      {
        error:
          'This order has already been fulfilled. Check your email for the scan link.',
        already_fulfilled: true,
        client_id: lead.client_id,
        public_id: publicId,
        onboarding_step: onboardingStep,
      },
      { status: 409 }
    );
  }

  // ─── 3. Resolve the address geo ────────────────────────────────────────
  // Two paths:
  //
  //   (a) Mapbox pick — when the intake form supplied latitude + longitude
  //       (the buyer chose from the Mapbox autocomplete dropdown), we
  //       USE those coordinates directly + read structured fields from
  //       body.components. Skips Nominatim entirely. This is the safe
  //       path: Mapbox gave us the canonical street + lat/lng for the
  //       buyer's actual chosen result, so there's no risk of
  //       same-name-different-city aliasing.
  //
  //   (b) Freeform fallback — the buyer typed without picking. Call
  //       Nominatim with whatever structured hints we have (city /
  //       region / postcode from `body.components` if present, via
  //       geocodeAddress's hints option). Hints make Nominatim respect
  //       disambiguators instead of letting its "importance" score
  //       silently land on a wrong-city match — the f60bdf9 fix for
  //       Hendricks Behavioral Hospital (Plainfield IN -> Auburn IN).
  let geocode: Awaited<ReturnType<typeof geocodeAddress>>;
  if (typeof body.latitude === 'number' && typeof body.longitude === 'number') {
    geocode = {
      lat: body.latitude,
      lng: body.longitude,
      display_name: body.address.trim(),
      importance: 1,
      components: body.components
        ? {
            street_address: body.components.street_address ?? null,
            city: body.components.city ?? null,
            region: body.components.region ?? null,
            postcode: body.components.postcode ?? null,
            country_code: body.components.country_code ?? null,
          }
        : undefined,
    };
  } else {
    geocode = await geocodeAddress(body.address, {
      hints: body.components
        ? {
            street: body.components.street_address ?? undefined,
            city: body.components.city ?? undefined,
            state: body.components.region ?? undefined,
            postalcode: body.components.postcode ?? undefined,
          }
        : undefined,
    });
  }
  if (!geocode) {
    await markLeadOrderFailed(
      supabase,
      body.sessionId,
      `geocode failed for: ${body.address}`
    );
    return NextResponse.json(
      {
        error:
          "We couldn't locate that address — please double-check the spelling. If it's correct, email support@turfmap.ai and we'll fire your scan manually.",
      },
      { status: 422 }
    );
  }

  // ─── 4. Insert the clients row ─────────────────────────────────────────
  const billingMode = billingModeForTier(session.tier);
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: body.businessName.trim(),
      address: body.address.trim(),
      latitude: geocode.lat,
      longitude: geocode.lng,
      phone: body.phone?.trim() || null,
      street_address: geocode.components?.street_address ?? null,
      city: geocode.components?.city ?? null,
      region: geocode.components?.region ?? null,
      postcode: geocode.components?.postcode ?? null,
      country_code: geocode.components?.country_code ?? 'USA',
      service_radius_miles: 1.6,
      status: 'active',
      billing_mode: billingMode,
      stripe_customer_id: session.customerId,
      stripe_subscription_id: session.subscriptionId,
      subscription_status:
        billingMode === 'self_serve_subscription' ? 'active' : null,
      // Self-serve subscription buyers (Pulse / Pulse+) drop into the
      // post-checkout onboarding wizard. One-time tiers (Audit /
      // Strategy / Scan) skip it — they're served by the Cal.com
      // embed on the success state instead.
      onboarding_step:
        billingMode === 'self_serve_subscription' ? 'gbp_match' : null,
    })
    .select('*')
    .single<ClientRow>();

  if (clientErr || !client) {
    const message = clientErr?.message ?? 'no row returned';
    await markLeadOrderFailed(
      supabase,
      body.sessionId,
      `client insert failed: ${message}`
    );
    return NextResponse.json(
      { error: `Order accepted but we couldn't create your account: ${message}. We'll follow up via email.` },
      { status: 500 }
    );
  }

  // Helper to roll back the client + its FK cascade if any later
  // step fails — keeps the database consistent. lead_orders rolls
  // forward to 'failed' so the operator queue can recover manually.
  async function rollback(reason: string) {
    if (client) {
      await supabase.from('clients').delete().eq('id', client.id);
    }
    await markLeadOrderFailed(supabase, body.sessionId, reason);
  }

  // ─── 5. Insert the primary location row ────────────────────────────────
  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: geocode.components?.city ?? null,
      address: body.address.trim(),
      street_address: geocode.components?.street_address ?? null,
      city: geocode.components?.city ?? null,
      region: geocode.components?.region ?? null,
      postcode: geocode.components?.postcode ?? null,
      country_code: geocode.components?.country_code ?? 'USA',
      phone: body.phone?.trim() || null,
      latitude: geocode.lat,
      longitude: geocode.lng,
      service_radius_miles: 1.6,
    })
    .select('*')
    .single<ClientLocationRow>();

  if (locErr || !location) {
    await rollback(`location insert failed: ${locErr?.message ?? 'no row'}`);
    return NextResponse.json(
      { error: `Order accepted but location setup failed: ${locErr?.message ?? 'unknown'}.` },
      { status: 500 }
    );
  }

  // Google Places enrichment — fire-and-forget. Looks up the GBP listing
  // for the buyer's business, stores place_id + initial signals snapshot
  // so the AI Coach can cite specific GBP signals. Soft-fails if the API
  // key isn't configured or the strict-match guardrail rejects.
  after(async () => {
    await enrichLocationFromOnboarding(supabase, {
      locationId: location.id,
      businessName: body.businessName.trim(),
      latitude: geocode.lat,
      longitude: geocode.lng,
    });
  });

  // Send the order-confirmation email NOW, before the scan fires.
  // The buyer just paid and clicked "submit" on the form — they want
  // immediate acknowledgement, not silence for 30+ seconds while DFS
  // runs. The scan-ready email follows after step 8 with the actual
  // dashboard link. Failures here are logged but don't block the
  // pipeline (sendOrderConfirmation already swallows errors).
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  // /portal — buyer-facing dashboard. Self-serve buyers can sign in
  // here via magic link; the agency-side /clients/<id> route would
  // redirect them to /login (agency-staff-only). All emails sent
  // out of this fulfill flow are to the BUYER, never the operator,
  // so /portal is the right destination.
  const dashboardUrl = `${origin}/portal/${client.public_id}`;
  // Cal.com booking link for Audit + Strategy buyers — pre-filled
  // with the buyer's email + business name. Returns null for tiers
  // without a strategist call OR when CAL_COM_*_URL env isn't set
  // yet; sendOrderConfirmation handles the null case gracefully.
  const bookingUrl = calcomBookingUrlForTier({
    tier: session.tier,
    email: body.email,
    businessName: body.businessName.trim(),
  });
  // Provision portal access BEFORE sending the confirmation email.
  // sendOrderConfirmation hands the buyer a /portal/<public_id> URL;
  // without a client_users row that URL bounces them at the agency-
  // portal sign-in page with a misleading "this email is not
  // authorized" error. Yohann at Ainger Group Roofing (original
  // cohort='cold_email' Stripe-checkout purchase) was the catalyst —
  // he held the email + clicked months later, no client_users row
  // existed, auth rejected him. Idempotent; non-fatal.
  try {
    await ensurePortalUser(supabase, client.id, body.email);
  } catch (e) {
    console.error(
      '[orders/fulfill] ensurePortalUser pre-email threw (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }

  await sendOrderConfirmation({
    to: body.email,
    businessName: body.businessName.trim(),
    tier: session.tier,
    dashboardUrl,
    bookingUrl,
  });

  // ─── 6. Insert tracked keywords ────────────────────────────────────────
  // Self-serve subscriptions use weekly cadence (Pulse) or weekly with
  // multi-keyword (Pulse+ — 3 keywords on weekly). One-time tiers also
  // store as 'weekly' so the keyword exists for any bundled re-scan,
  // but the cron's billing-mode gate means one-time clients won't be
  // picked up by scheduled scans (only their bundled re-scans, fired
  // via separate logic).
  const keywordRows: TrackedKeywordRow[] = [];
  for (let i = 0; i < body.keywords.length; i++) {
    const kw = body.keywords[i].trim();
    const { data: kwRow, error: kwErr } = await supabase
      .from('tracked_keywords')
      .insert({
        client_id: client.id,
        location_id: location.id,
        keyword: kw,
        scan_frequency: 'weekly',
        is_primary: i === 0,
      })
      .select('*')
      .single<TrackedKeywordRow>();
    if (kwErr || !kwRow) {
      await rollback(
        `keyword[${i}] "${kw}" insert failed: ${kwErr?.message ?? 'no row'}`
      );
      return NextResponse.json(
        { error: `Order accepted but keyword setup failed: ${kwErr?.message ?? 'unknown'}.` },
        { status: 500 }
      );
    }
    keywordRows.push(kwRow);
  }

  // ─── 7. Trigger scans (one per keyword) in parallel ────────────────────
  // For strategy/pulse_plus this fires 3 scans at once. ~30s each
  // typical, all running concurrently against DFS. We wait for all
  // of them before returning so the buyer sees a "scan complete"
  // success state with the link.
  const scanResults = await Promise.all(
    keywordRows.map((keyword) =>
      runScanForLocation(supabase, {
        client,
        location,
        keyword,
        scanType: 'on_demand',
        // triggeredBy is null for self-serve fulfillment — there's
        // no agency operator behind the request. The audit-trail
        // value is in lead_orders.client_id, not the scan row.
        triggeredBy: null,
      })
    )
  );

  const failedScans = scanResults.filter((r) => !r.ok);
  if (failedScans.length > 0) {
    // Partial-failure path: client + location + keywords are all
    // created but at least one scan failed. We DON'T roll back the
    // client (the buyer can retry the scan later from the dashboard).
    // We mark lead_order as fulfilled (because the data setup
    // succeeded) and return a degraded success.
    const errMsg = failedScans.map((r) => (r.ok ? '' : r.error)).join('; ');
    console.error('[orders/fulfill] partial scan failure', errMsg);
    // Same metadata stamp as the success path so the audit-call
    // reminder cron + Cal.com webhook still wire up correctly even
    // when the scan itself partially failed.
    const isAuditTierPartial =
      session.tier === 'audit' || session.tier === 'strategy';
    await markLeadOrderFulfilled(
      supabase,
      body.sessionId,
      client.id,
      isAuditTierPartial
        ? {
            audit_call_status: 'unbooked',
            audit_call_initiated_at: new Date().toISOString(),
          }
        : undefined
    );

    // Pulse+ welcome still fires on partial failure — the citation-
    // build onboarding form is independent of scan completion, and the
    // buyer paid for Pulse+ either way. Scan-ready email is suppressed
    // here; it'll fire when the retry pipeline (TODO) lands.
    if (session.tier === 'pulse_plus') {
      // Buyer-facing portal URL — the citation onboarding form
      // currently lives at an agency-only route, so we send the
      // buyer to their portal and the operator follows up by
      // email/Slack to gather categories + hours. Will swap to a
      // direct citation-onboarding URL once we ship buyer access
      // to that form (planned follow-up).
      const onboardingUrl = `${origin}/portal/${client.public_id}`;
      await sendPulsePlusWelcome({
        to: body.email,
        businessName: body.businessName.trim(),
        onboardingUrl,
      });
    }

    return NextResponse.json({
      ok: true,
      partial: true,
      client_id: client.id,
      public_id: client.public_id,
      successful_scans: scanResults
        .filter((r) => r.ok)
        .map((r) => (r.ok ? r.scanId : null))
        .filter(Boolean),
      failed_scan_count: failedScans.length,
      booking_url: bookingUrl,
      onboarding_step: client.onboarding_step,
      message:
        "Your account is set up but one or more scans hit a transient error. We'll retry automatically and email you when they're complete.",
    });
  }

  // ─── 8. Mark lead_order fulfilled ──────────────────────────────────────
  // For Audit + Strategy tiers, also stamp the call-tracking
  // metadata used by the Cal.com webhook. Initial state is
  // 'unbooked' — the Cal.com BOOKING_CREATED webhook flips it to
  // 'booked' (and cancels the queued reminder email below).
  const isAuditTier = session.tier === 'audit' || session.tier === 'strategy';
  const fulfilled = await markLeadOrderFulfilled(
    supabase,
    body.sessionId,
    client.id,
    isAuditTier
      ? {
          audit_call_status: 'unbooked',
          audit_call_initiated_at: new Date().toISOString(),
        }
      : undefined
  );
  if (!fulfilled.ok) {
    // Non-fatal — the data is all written, the lead_orders row just
    // didn't transition. Log for operator follow-up. Buyer still
    // sees success.
    console.error(
      '[orders/fulfill] markLeadOrderFulfilled failed (non-fatal)',
      fulfilled.error
    );
  }

  // ─── 8a2. Stamp prospects.converted_at if this was a cold-email buyer
  // The /yourmap lander forwards ?prospect_id=<nanoid> through the
  // Stripe Checkout session metadata. When fulfillment lands, mark
  // the prospect as converted so (a) the lander's 410-already-
  // converted gate fires on subsequent visits, and (b) the
  // cold-email funnel dashboard can join conversions back to the
  // originating outreach record. Idempotent — second fulfillment
  // hits the same row and overwrites with the same timestamp.
  if (session.prospectId && fulfilled.ok) {
    try {
      const { error: prospectErr } = await supabase
        .from('prospects')
        .update({ converted_at: new Date().toISOString() })
        .eq('id', session.prospectId)
        .is('converted_at', null);
      if (prospectErr) {
        console.error(
          '[orders/fulfill] prospects.converted_at stamp failed (non-fatal)',
          prospectErr.message
        );
      }
    } catch (e) {
      console.error(
        '[orders/fulfill] prospects stamp threw (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // ─── 8b. Queue the audit-call reminder via Resend scheduled-send ──────
  // For Audit + Strategy buyers: schedule a 20-min-delayed reminder
  // email pointing at their Cal.com booking link. If they book inside
  // the window, the Cal.com webhook handler cancels this scheduled
  // email so they don't get a "you forgot to book" nudge after just
  // confirming. We persist the returned email ID on
  // lead_orders.stripe_metadata.audit_reminder_email_id so the webhook
  // knows which Resend email to cancel.
  //
  // Why scheduled-send instead of a Vercel Cron sweep: Vercel Hobby
  // tier caps cron frequency at daily. Resend's scheduled-send
  // delivers the same UX (precise 20-min mark, cancellable) and works
  // on any plan. The /api/cron/audit-call-reminders route is kept in
  // the repo as a manual fallback but is no longer auto-fired.
  if (isAuditTier && bookingUrl && fulfilled.ok) {
    const scheduledAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    try {
      const reminderResult = await sendAuditCallReminder({
        to: body.email,
        businessName: body.businessName.trim(),
        bookingUrl,
        scheduledAt,
      });
      if (reminderResult.ok && reminderResult.id) {
        // Stamp the email ID + scheduled time onto the lead_orders
        // row so the Cal.com webhook can cancel the queued send if
        // a booking lands inside the 20-min window.
        await patchLeadOrderMetadataByClientId(supabase, client.id, {
          audit_reminder_email_id: reminderResult.id,
          audit_reminder_scheduled_at: scheduledAt,
        });
      } else {
        // Non-fatal — scan + onboarding already succeeded; the buyer
        // has the success page + the dashboard email already. Worst
        // case they don't get the 20-min nudge, the operator picks
        // them up via the agency dashboard's pending-bookings view.
        console.error(
          '[orders/fulfill] sendAuditCallReminder schedule failed',
          { ok: reminderResult.ok, hasId: !!reminderResult.id }
        );
      }
    } catch (e) {
      // Same rationale as above — log + continue, don't fail the
      // order on a downstream email-scheduling hiccup.
      console.error(
        '[orders/fulfill] sendAuditCallReminder threw',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // The primary scan result is referenced by both the
  // visibility_audits stamp (Phase 1, below) and the scan-ready
  // email (Section 9, further below). Pull it once here so both
  // can read it without duplicating the index lookup.
  const primaryScanResult = scanResults[0];

  // ─── 8c. Stamp the visibility_audits row (Phase 1 foundation) ────────
  // For Audit + Strategy tiers: insert a visibility_audits row
  // capturing the buyer's starting state + LLM Fit Score. The row
  // anchors:
  //   - the at-purchase Roadmap PDF generation (helper below)
  //   - the T-24h pre-call prep packet to Anthony (audit-milestones
  //     cron's sweepPreCall)
  //   - the post-call follow-up sweeps (day-25 re-scan reminder,
  //     day-60 check-in prompt, day-67 nudge)
  //
  // For Strategy (3-keyword purchase), the row tracks the PRIMARY
  // keyword's scan. The other two scans still exist in the DB for
  // the comparative analysis Anthony builds post-call; the
  // visibility_audits row + auto-Roadmap PDF reference the primary
  // keyword only, matching how the PDF template handles single-
  // keyword input. Anthony layers the multi-keyword comparison on
  // top manually using the agency dashboard's per-scan views.
  if (
    (session.tier === 'audit' || session.tier === 'strategy') &&
    primaryScanResult?.ok &&
    fulfilled.ok
  ) {
    try {
      // Trade fit: infer from the primary keyword. Conservative
      // matcher — only TRUE when we can confidently classify into
      // one of the LLM_TARGET_TRADES; otherwise NULL ("we don't
      // know") rather than FALSE.
      const tradeFit = inferTradeFitFromKeyword(body.keywords[0]);

      const fitBreakdown = computeLlmFitScore({
        // We don't yet have Apollo revenue data at fulfillment time
        // — leave the band null so the score's confidence-penalty
        // rule kicks in. Phase 4 (Apollo enrichment) will re-stamp
        // the score with revenue + ad-active signals when those
        // resolve asynchronously.
        revenueBand: null,
        tradeFit,
        // Metro fit needs a population dataset we haven't wired
        // yet. Pass null so the score doesn't disqualify based on
        // an unknown.
        metroFit: null,
        adActive: null,
        reviewCount: null,
      });

      const auditResult = await createVisibilityAudit(supabase, {
        leadOrderId: lead.id,
        scanId: primaryScanResult.scanId,
        clientId: client.id,
        startingTurfScore: primaryScanResult.turfScore,
        liftPromiseTargetScore: null, // populated by the Roadmap pipeline (Phase 2)
        llmFitScore: fitBreakdown.score,
        llmFitBreakdown: fitBreakdown,
      });
      if (!auditResult.ok) {
        console.error(
          '[orders/fulfill] createVisibilityAudit failed (non-fatal)',
          auditResult.error
        );
      } else {
        const auditId = auditResult.row.id;

        // Trigger NAP audit at audit-init. Fire-and-forget — the
        // BL/DFS run takes ~5-15min, the at-purchase Roadmap PDF
        // ships immediately with whatever findings are available
        // (often empty on first run for cold-prospect bootstraps),
        // and the T-24h pre-call cron regenerates the PDF with the
        // populated findings later. For paid audit buyers whose
        // intake captured phone + structured address, this is a
        // near no-op — maybeRunNapAudit's idempotency gate fires on
        // the scan-time call from runScanForLocation.
        void triggerNapAuditAtAuditInit(supabase, auditId, {
          operatorOrigin: origin,
        }).then((r) => {
          if (!r.ok) {
            console.error(
              '[orders/fulfill] triggerNapAuditAtAuditInit failed',
              r.stage,
              r.error
            );
          }
        });

        // (Portal access already provisioned before sendOrderConfirmation
        // above — applies to all paid tiers, not just audit.)

        if (shouldPitchLlm(fitBreakdown.score)) {
          // Fire the operator Slack notification for fit-4-and-up
          // audits. Fail-soft — if the webhook isn't configured or
          // the call fails, we log + continue. The audit is still
          // captured; this is just a manual-touch nudge for Anthony's
          // pipeline awareness.
          await notifyLlmFitAudit({
            businessName: body.businessName.trim(),
            trade: body.keywords[0] ?? 'unknown',
            market: geocode.components?.city ?? body.address.trim(),
            currentTurfScore: primaryScanResult.turfScore,
            llmFitScore: fitBreakdown.score,
            auditDashboardUrl: `${origin}/clients/${client.public_id}`,
          }).catch((e) => {
            console.error(
              '[orders/fulfill] notifyLlmFitAudit failed (non-fatal)',
              e instanceof Error ? e.message : String(e)
            );
          });
        }

        // ─── Auto-generate the 90-Day Roadmap PDF + email to operator ─
        // Same auto-generation flow that used to be a manual one-off
        // script (scripts/generate-ryan-audit-pdf.ts) — now fires for
        // every paying audit buyer. Runs in after() so the ~30-60s
        // Claude + PDF render + upload + email roundtrip doesn't
        // block the fulfill response (the buyer's success page lands
        // immediately; the Roadmap email arrives in Anthony's inbox
        // ~60s later).
        //
        // The PDF goes to Anthony (operator), NOT the buyer. Anthony
        // reviews it before the strategist call (or before manual
        // outreach when the buyer hasn't booked Cal.com yet) and
        // sends the deliverable to the buyer himself post-call so it
        // arrives with strategist context, not as a cold automated
        // attachment. The buyer's only audit-tier email at this stage
        // is sendScanReady (no PDF).
        //
        // Fully fail-soft: any error here is logged but doesn't
        // bubble. The T-24h cron will still regenerate fresh for the
        // pre-call prep packet, so a missed at-purchase generation
        // isn't a lost deliverable — just a slower one.
        const buyerEmail = body.email.trim();
        const buyerPhone = body.phone?.trim() || null;
        const buyerBusinessName = body.businessName.trim();
        const buyerKeyword = body.keywords[0] ?? 'unknown';
        const buyerMarket = geocode.components?.city ?? body.address.trim();
        const buyerLlmFit = fitBreakdown.score;
        const agencyDashboardUrl = `${origin}/clients/${client.public_id}`;
        // Human-readable tier label for the operator email subject +
        // body. Strategy buyers paid $1,497 and bought the 3-keyword
        // deliverable; audit buyers paid $499 for the single-keyword
        // version. Anthony scans the inbox by subject so this needs
        // to read correctly per tier.
        const tierLabel =
          session.tier === 'strategy' ? 'Strategy Session' : 'Visibility Audit';
        after(async () => {
          try {
            const result = await generateAndStoreRoadmapPdf(
              supabase,
              auditId
            );
            if (!result.ok) {
              console.error(
                '[orders/fulfill] roadmap-pdf generation failed',
                result.stage,
                result.error
              );
              return;
            }
            // Re-fetch the audit row after the helper's patch landed
            // so the email surfaces the stamped lift_promise_target.
            // Falls back to the in-memory generation result on a miss.
            const { data: refreshed } = await supabase
              .from('visibility_audits')
              .select('starting_turfscore, lift_promise_target_score')
              .eq('id', auditId)
              .maybeSingle<{
                starting_turfscore: number | null;
                lift_promise_target_score: number | null;
              }>();
            const sent = await sendAuditPurchaseRoadmap({
              to: OPERATOR_AUDIT_EMAIL,
              businessName: buyerBusinessName,
              tierLabel,
              buyerEmail,
              buyerPhone,
              market: buyerMarket,
              trade: buyerKeyword,
              startingTurfScore:
                refreshed?.starting_turfscore ?? primaryScanResult.turfScore,
              projectedTurfScore:
                refreshed?.lift_promise_target_score ??
                result.projectedTurfScore,
              llmFitScore: buyerLlmFit,
              diagnosisPreview: previewDiagnosis(result.diagnosis),
              agencyDashboardUrl,
              pdf: {
                filename: `${slugifyBusinessName(buyerBusinessName)}-visibility-roadmap.pdf`,
                content: result.pdfBuffer,
              },
            });
            if (!sent) {
              console.error(
                '[orders/fulfill] sendAuditPurchaseRoadmap returned false'
              );
            }
          } catch (e) {
            console.error(
              '[orders/fulfill] roadmap-pdf after() threw',
              e instanceof Error ? e.message : String(e)
            );
          }
        });
      }
    } catch (e) {
      // Same fail-soft pattern as the rest of the post-fulfill block.
      console.error(
        '[orders/fulfill] visibility_audits stamp threw (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // ─── 8.5 Pending audit-upgrade sweep (scan tier only) ─────────────────
  // When the buyer purchased an audit upgrade BEFORE filling intake,
  // the webhook stored a pending lead_orders row with client_id=null
  // and stripe_metadata.pending_client_session_id=<this scan session>.
  // Now that intake is complete and client_id + scan_id exist, link
  // the upgrade row → create its visibility_audits row → stamp the
  // prospect → send the audit-upgrade confirmation email.
  //
  // Fail-soft: any error here doesn't fail the scan fulfillment. The
  // pending row remains in the DB for manual recovery if needed.
  if (session.tier === 'scan' && primaryScanResult?.ok && client) {
    try {
      const { data: pendingUpgrades } = await supabase
        .from('lead_orders')
        .select('*')
        .eq('tier', 'audit')
        .eq('status', 'pending')
        .is('client_id', null)
        .filter(
          'stripe_metadata->>pending_client_session_id',
          'eq',
          session.sessionId
        );

      for (const pending of pendingUpgrades ?? []) {
        const pendingMeta =
          (pending.stripe_metadata as Record<string, unknown> | null) ?? {};

        // Link client_id + flip to fulfilled.
        await supabase
          .from('lead_orders')
          .update({
            client_id: client.id,
            status: 'fulfilled',
            stripe_metadata: {
              ...pendingMeta,
              original_scan_id: primaryScanResult.scanId,
              fulfilled_via_intake_sweep_at: new Date().toISOString(),
            },
          })
          .eq('id', pending.id);

        // Compute LLM fit score same way the audit-tier path does.
        const tradeFit = inferTradeFitFromKeyword(body.keywords[0]);
        const fitBreakdown = computeLlmFitScore({
          revenueBand: null,
          tradeFit,
          metroFit: null,
          adActive: null,
          reviewCount: null,
        });

        // Create the visibility_audits row now that scan_id +
        // client_id exist.
        const auditResult = await createVisibilityAudit(supabase, {
          leadOrderId: pending.id,
          scanId: primaryScanResult.scanId,
          clientId: client.id,
          startingTurfScore: primaryScanResult.turfScore,
          liftPromiseTargetScore: null,
          llmFitScore: fitBreakdown.score,
          llmFitBreakdown: fitBreakdown,
        });
        if (!auditResult.ok) {
          console.error(
            '[orders/fulfill] pending-upgrade visibility_audits insert failed',
            auditResult.error,
            pending.id
          );
        }

        // Stamp prospects.upgraded_to_audit_at if the original
        // purchase was from a cold-email cohort.
        const prospectId =
          typeof pendingMeta.prospect_id === 'string'
            ? pendingMeta.prospect_id
            : null;
        if (prospectId) {
          await supabase
            .from('prospects')
            .update({ upgraded_to_audit_at: new Date().toISOString() })
            .eq('id', prospectId)
            .is('upgraded_to_audit_at', null);
        }

        console.log(
          '[orders/fulfill] swept pending audit_upgrade',
          pending.id,
          '→ client',
          client.id
        );
      }
    } catch (e) {
      console.error(
        '[orders/fulfill] pending-upgrade sweep threw (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // ─── 9. Send the scan-ready email + (Pulse+) welcome email ────────────
  // Both are fire-and-await with errors swallowed inside the senders,
  // so a transient Resend hiccup doesn't fail the order. The dashboard
  // success state on /order/success is still the primary delivery path
  // — email is the secondary "you can come back anytime" handoff.
  // For multi-keyword tiers (Strategy / Pulse+), the email surfaces
  // the primary keyword's metrics — clearest single-number summary.
  const scanReadyMetrics =
    primaryScanResult && primaryScanResult.ok
      ? {
          turfScore: primaryScanResult.turfScore,
          turfReach: primaryScanResult.turfReach,
          turfRank: primaryScanResult.turfRank,
        }
      : undefined;
  await sendScanReady({
    to: body.email,
    businessName: body.businessName.trim(),
    dashboardUrl,
    metrics: scanReadyMetrics,
  });
  if (session.tier === 'pulse_plus') {
    // Pulse+ needs a richer NAP/category profile before BL Citation
    // Builder can submit. The onboarding-form route doesn't exist yet
    // (lands with the citation-builder integration), so for now we
    // route the buyer to the dashboard's settings page where they can
    // fill in the missing fields manually. Update this URL once the
    // dedicated onboarding flow ships.
    const onboardingUrl = `${origin}/clients/${client.public_id}/settings`;
    await sendPulsePlusWelcome({
      to: body.email,
      businessName: body.businessName.trim(),
      onboardingUrl,
    });
  }

  const scanIds = scanResults
    .map((r) => (r.ok ? r.scanId : null))
    .filter((id): id is string => id != null);

  // ─── 10. Operator Slack notification (#llm-leads) ─────────────────────
  // Fire-and-forget — failure here is non-fatal. The buyer's success
  // state ships either way. Operator feed in #llm-leads is the manual
  // touchpoint for lander conversions; #llm-leads notifications for
  // audit upgrades fire from /api/upgrade/audit/confirm instead, and
  // COLDSCAN-cohort free buyers route through
  // /api/yourmap/coldscan-fulfill which has its own notification.
  //
  // We notify on EVERY paid lander tier (scan / audit / strategy /
  // pulse / pulse_plus). Not gated on coupon — even a 100%-off VIP
  // /freescan order produces a #llm-leads ping so Anthony has a feed
  // of every conversion, regardless of price.
  after(async () => {
    try {
      await notifyTurfScanPurchase({
        businessName: body.businessName.trim(),
        tier: session.tier,
        amountCents: session.amountTotal ?? 0,
        coupon: session.coupon,
        keyword: body.keywords[0] ?? '',
        city: geocode.components?.city ?? '',
        utmSource: session.utmSource,
        utmContent: session.utmContent,
        prospectId: session.prospectId,
        shareUrl: `${origin}/clients/${client.public_id}`,
      });
    } catch (e) {
      console.error(
        '[orders/fulfill] notifyTurfScanPurchase failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  });

  return NextResponse.json({
    ok: true,
    client_id: client.id,
    public_id: client.public_id,
    scan_ids: scanIds,
    primary_scan_id: scanIds[0] ?? null,
    // For audit/strategy buyers, return the Cal.com URL so the
    // success page can surface an inline "Book your call" CTA
    // without refetching from /api/orders/booking-link or similar.
    booking_url: bookingUrl,
    // For self-serve subscription buyers, return the wizard step so
    // the success page can render the OnboardingWizard inline.
    onboarding_step: client.onboarding_step,
  });
}

/** Map a LoadSessionError into the appropriate JSON envelope + status
 *  code. Centralized so the ordering of error precedence stays
 *  consistent across callers. */
function errorForLoadSession(err: LoadSessionError): NextResponse {
  switch (err.kind) {
    case 'stripe_not_configured':
      return NextResponse.json(STRIPE_NOT_CONFIGURED_ERROR, { status: 503 });
    case 'session_not_found':
      return NextResponse.json(
        { error: 'Stripe session not found — checkout link looks malformed.' },
        { status: 404 }
      );
    case 'invalid_tier':
      return NextResponse.json(
        {
          error: `Stripe session is missing a recognized tier (got "${err.tierValue ?? 'null'}"). Email support@turfmap.ai with your session id.`,
        },
        { status: 400 }
      );
    case 'payment_not_complete':
      return NextResponse.json(
        {
          error: `Payment status on this session is "${err.paymentStatus ?? 'unknown'}", not "paid". If you completed payment and got this error, contact support.`,
        },
        { status: 402 }
      );
    case 'stripe_error':
      return NextResponse.json(
        { error: `Stripe lookup failed: ${err.message}` },
        { status: 502 }
      );
  }
}

/**
 * First-sentence-ish preview of the AI Roadmap diagnosis blurb for
 * the buyer's roadmap-ready email. The PDF embeds the full diagnosis
 * on the cover page; this is just the teaser the email body quotes
 * so the buyer reads the headline before opening the attachment.
 * Capped at ~220 chars so it doesn't blow out the email layout.
 */
function previewDiagnosis(diagnosis: string): string {
  const trimmed = diagnosis.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 220) return trimmed;
  // Prefer to cut at a sentence boundary near the cap.
  const sliced = trimmed.slice(0, 220);
  const lastPeriod = sliced.lastIndexOf('. ');
  if (lastPeriod > 80) return `${sliced.slice(0, lastPeriod + 1)}`;
  return `${sliced.trim()}…`;
}

/**
 * Slug a business name into a safe filename component for the
 * Roadmap PDF attachment. Lowercase, hyphens, ASCII-only. Falls back
 * to 'turfmap' on empty input so we always have a valid filename.
 */
function slugifyBusinessName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'turfmap';
}

/**
 * Map a buyer's primary keyword to one of the LLM target trades.
 * Returns the matched trade or null when no confident classification
 * is possible. Used at audit fulfillment to compute the buyer's
 * tradeFit signal for the LLM Fit Score; called once per order, so
 * O(n*m) string matching against the keyword is fine.
 *
 * Intentionally narrow: we only flip tradeFit=TRUE when the keyword
 * unambiguously names one of LLM_TARGET_TRADES. Any ambiguous keyword
 * ("local services", "home services") returns null so the Fit
 * Score treats it as unknown rather than falsely positive.
 */
function inferTradeFitFromKeyword(keyword: string | undefined): boolean | null {
  if (!keyword) return null;
  const k = keyword.toLowerCase();
  // Each entry: array of canonical-trade keywords that, if present,
  // resolve to that trade. Order matters only insofar as more-specific
  // matches should appear before broader ones — none of these
  // currently overlap, so order is alphabetical.
  const TRADE_KEYWORDS: Array<{ trade: LlmTargetTrade; needles: string[] }> = [
    { trade: 'electrical', needles: ['electrician', 'electrical'] },
    { trade: 'hvac', needles: ['hvac', 'heating', 'air conditioning', 'a/c repair', 'furnace'] },
    { trade: 'landscaping', needles: ['landscap', 'lawn care', 'lawn maintenance'] },
    { trade: 'plumbing', needles: ['plumb', 'drain cleaning', 'water heater'] },
    { trade: 'renovation', needles: ['renovat', 'remodel', 'kitchen remodel', 'bathroom remodel'] },
    { trade: 'restoration', needles: ['restoration', 'water damage', 'fire damage', 'mold remediation'] },
    { trade: 'roofing', needles: ['roof'] },
    { trade: 'windows_doors', needles: ['windows', 'doors', 'window install', 'door install'] },
  ];
  for (const { trade, needles } of TRADE_KEYWORDS) {
    for (const needle of needles) {
      if (k.includes(needle)) {
        // Sanity-check the matched trade is in the canonical list.
        // (Belt-and-suspenders — if LLM_TARGET_TRADES drifts, we'd
        // rather a typecheck error here than a runtime mis-classify.)
        if ((LLM_TARGET_TRADES as readonly string[]).includes(trade)) {
          return true;
        }
      }
    }
  }
  return null; // unknown — not a confident TRUE or FALSE
}
