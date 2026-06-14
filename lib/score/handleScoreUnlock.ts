/**
 * handleScoreUnlockCompletion — webhook handler for the /score → $99
 * Stripe Checkout unlock flow.
 *
 * Fires on checkout.session.completed when metadata.source ==
 * 'score_unlock'. Flips the preview client to a real paid scan buyer
 * by mutating exactly the columns the operator dashboards + portal
 * routes already filter on.
 *
 * What happens here (all idempotent — webhook retries converge):
 *
 *   1. Load the Stripe session metadata: share_id, client_id, scan_id.
 *   2. Resolve the existing preview client. If is_preview is already
 *      false, the buyer hit unlock twice or the webhook is retrying
 *      a prior success — no-op.
 *   3. Insert lead_orders row stamped with stripe_session_id, status=
 *      'fulfilled', source='score_unlock'. UNIQUE on stripe_session_id
 *      makes the retry path safe.
 *   4. Flip clients.is_preview=false, billing_mode='one_time',
 *      tier='scan', stripe_customer_id=<from session>, status='active'.
 *      Now the row reads as a normal paid TurfScan buyer everywhere
 *      downstream.
 *   5. Provision portal access via ensurePortalUser so the buyer can
 *      magic-link into /portal/<public_id> later.
 *   6. Fire-and-forget side effects in after():
 *        - generateInsight (the AI Coach Fix List, deliberately
 *          skipped at preview time to save Claude tokens — now runs)
 *        - sendOrderConfirmation + sendScanReady emails
 *        - notifyTurfScanPurchase operator Slack ping
 *
 * /order/success runs concurrently — both paths are idempotent on
 * lead_orders.status='fulfilled', so whichever lands first wins and
 * the other no-ops.
 */

import type Stripe from 'stripe';
import { after } from 'next/server';
import type { getServerSupabase } from '@/lib/supabase/server';
import { generateInsight } from '@/lib/ai-coach/generateInsight';
import { ensurePortalUser } from '@/lib/auth/ensurePortalUser';
import {
  cancelScheduledEmail,
  sendOrderConfirmation,
  sendPulseRecovery,
  sendScanReady,
} from '@/lib/email/resend';
import { notifyTurfScanPurchase } from '@/lib/audit/operatorSlack';
import { portalUrl } from '@/lib/urls';
import {
  sendMetaCapiEvent,
  buildFbcFromFbclid,
} from '@/lib/marketing/metaCapi';
import { randomUUID } from 'crypto';
import type {
  ClientRow,
  LeadOrderRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

// Webhook handlers run server-side with no incoming request origin,
// so we hardcode the prod hostname for outbound URLs. Mirrors the
// same pattern other webhook side-effects use (see lib/audit/
// operatorSlack and the handleAuditUpgradeCompletion flow).
const APP_ORIGIN = 'https://turfmap.ai';

export async function handleScoreUnlockCompletion(
  supabase: ReturnType<typeof getServerSupabase>,
  session: Stripe.Checkout.Session
): Promise<void> {
  const meta = (session.metadata ?? {}) as Record<string, string>;
  const shareId = meta.share_id ?? null;
  const clientId = meta.client_id ?? null;
  const scanId = meta.scan_id ?? null;
  const businessName = meta.business_name ?? null;

  if (!shareId || !clientId || !scanId) {
    console.error(
      '[score-unlock] session missing required metadata',
      session.id,
      { shareId, clientId, scanId }
    );
    return;
  }

  // ─── 1. Idempotency: lead_orders row exists for this session? ──────
  const { data: existing } = await supabase
    .from('lead_orders')
    .select('id, status')
    .eq('stripe_session_id', session.id)
    .maybeSingle<Pick<LeadOrderRow, 'id' | 'status'>>();
  if (existing) {
    return;
  }

  // ─── 2. Resolve the preview client + scan ──────────────────────────
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (!client) {
    console.error('[score-unlock] client not found', clientId);
    return;
  }
  // If is_preview is already false, the buyer's previous Checkout
  // already unlocked. No-op — Stripe webhook retried after a prior
  // success.
  if (!client.is_preview) {
    return;
  }

  const { data: scan } = await supabase
    .from('scans')
    .select('id, turf_score, turf_reach, turf_rank, total_points')
    .eq('id', scanId)
    .maybeSingle<
      Pick<
        ScanRow,
        'id' | 'turf_score' | 'turf_reach' | 'turf_rank' | 'total_points'
      >
    >();
  if (!scan) {
    console.error('[score-unlock] scan not found', scanId);
    return;
  }

  // Primary keyword + city — needed for the operator Slack notification.
  // Look up directly from tracked_keywords / clients (we already have
  // client loaded; the city lives there).
  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('keyword')
    .eq('client_id', clientId)
    .eq('is_primary', true)
    .limit(1)
    .maybeSingle<Pick<TrackedKeywordRow, 'keyword'>>();
  const primaryKeyword = keyword?.keyword ?? 'n/a';

  // Resolve buyer email + Stripe customer id from the Checkout
  // session. Email is captured at Checkout time even when the buyer
  // didn't pre-fill it on /score (Stripe collects it as part of
  // payment). Falls back to the preview lead_orders row's email if
  // present.
  const email =
    session.customer_details?.email ??
    session.customer_email ??
    (await loadPreviewEmail(supabase, clientId));
  if (!email) {
    console.error('[score-unlock] no buyer email available', session.id);
    return;
  }
  const stripeCustomerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null;

  // ─── 3. Insert lead_orders (status='fulfilled', source='score_unlock')
  // UNIQUE constraint on stripe_session_id makes the retry path safe —
  // a second insert returns 23505 which we treat as already-done.
  const stripeMetadata: Record<string, string> = {
    source: 'score_unlock',
    share_id: shareId,
    scan_id: scanId,
  };
  if (businessName) stripeMetadata.business_name = businessName;

  const { error: orderErr } = await supabase.from('lead_orders').insert({
    stripe_session_id: session.id,
    tier: 'scan',
    status: 'fulfilled',
    email,
    client_id: clientId,
    stripe_metadata: stripeMetadata,
  });
  if (orderErr) {
    const code = (orderErr as { code?: string }).code;
    if (code === '23505') {
      // UNIQUE violation = another path already inserted. Idempotent.
      return;
    }
    console.error(
      '[score-unlock] lead_orders insert failed',
      session.id,
      orderErr.message
    );
    return;
  }

  // ─── 4. Flip client to "real paid scan buyer" state ────────────────
  // is_preview=false unhides it everywhere. billing_mode='one_time'
  // marks the buyer as a one-shot purchase (vs an agency-managed
  // subscription). status='active' so it appears in the operator
  // dashboard. stripe_customer_id captures the Stripe link so future
  // audit-upgrade Checkouts can pre-bind it.
  //
  // We deliberately do NOT touch `tier`. The clients.tier column has
  // a CHECK constraint that allows only 'pulse' or 'pulse_plus' —
  // those are subscription-tier markers (Pulse = monthly tracking,
  // Pulse+ = monthly tracking + citations). A one-time score_unlock
  // buyer has no subscription, so tier stays NULL (its default for
  // preview-clients). Writing 'scan' here used to silently violate
  // clients_tier_check, abort the entire UPDATE, and leave is_preview
  // stuck at true — which left every paid buyer in a half-broken
  // portal state. See JE/CertaPro Calgary incident 2026-06-04.
  const { error: clientUpdateErr } = await supabase
    .from('clients')
    .update({
      is_preview: false,
      billing_mode: 'one_time',
      status: 'active',
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    })
    .eq('id', clientId);
  if (clientUpdateErr) {
    // This used to be swallowed with a console.error and the handler
    // would continue — emails shipped to a buyer whose client row
    // was still in preview state, producing a half-broken portal.
    // Now we surface to Slack so the operator can hand-fix the row
    // before the buyer notices. We still don't `return` (the order
    // is recorded, the buyer should still get their emails) but the
    // alert is loud enough to act on.
    console.error(
      '[score-unlock] client update failed',
      clientId,
      clientUpdateErr.message
    );
    try {
      const { postOperatorSlack } = await import('@/lib/audit/operatorSlack');
      await postOperatorSlack({
        text:
          `:rotating_light: *score_unlock: clients UPDATE failed* — manual fix needed.\n` +
          `client_id=\`${clientId}\` (${client.business_name})\n` +
          `Buyer paid + lead_orders fulfilled, but is_preview stayed true.\n` +
          `Error: \`${clientUpdateErr.message}\`\n` +
          `Hand-fix: \`UPDATE clients SET is_preview=false, billing_mode='one_time', status='active'${
            stripeCustomerId
              ? `, stripe_customer_id='${stripeCustomerId}'`
              : ''
          } WHERE id='${clientId}';\``,
      });
    } catch (slackErr) {
      console.error(
        '[score-unlock] operator Slack alert also failed',
        slackErr instanceof Error ? slackErr.message : String(slackErr)
      );
    }
  }

  // ─── 4b. Cancel pending unlock-drip emails ─────────────────────────
  // The /api/score/preview-init route stamped Resend ids for the
  // 24h + 72h scheduled touches on the preview lead_orders row.
  // Read them off the preview lead_orders metadata (looked up by
  // client_id, not session_id — the preview row predates this
  // Stripe session) and cancel each. Best-effort: a cancellation
  // failure shouldn't block the unlock from completing.
  const { data: previewOrder } = await supabase
    .from('lead_orders')
    .select('id, stripe_metadata')
    .eq('client_id', clientId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{
      id: string;
      stripe_metadata: Record<string, string> | null;
    }>();
  if (previewOrder?.stripe_metadata) {
    const meta = previewOrder.stripe_metadata;
    const pendingIds = [
      meta.unlock_touch_2_email_id,
      meta.unlock_touch_3_email_id,
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    for (const id of pendingIds) {
      try {
        await cancelScheduledEmail(id);
      } catch (e) {
        console.warn(
          '[score-unlock] cancelScheduledEmail threw for',
          id,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
    // We deliberately DON'T flip the preview lead_orders row's
    // status — LeadOrderStatus is 'pending' | 'fulfilled' | 'failed'
    // and none of those captures "converted to paid via this other
    // row." The preview row stays as-is for the conversion audit
    // trail; the new fulfilled row (inserted in step 3) is the
    // canonical post-unlock record.
  }

  // ─── 5. Provision portal access (DUAL-EMAIL) ───────────────────────
  // Stripe captures the buyer's payment-method email at Checkout
  // (e.g. justinenns@gmail.com — the personal address they're logged
  // into Stripe with). The buyer originally filled the /free-score
  // or /prove-it form with a DIFFERENT email (jenns@certapro.com —
  // their work address). When those two differ — which they almost
  // always do for B2B buyers — the buyer's mental model says "I
  // signed up with my work email, that should be my login." Without
  // dual-provisioning, they hit the portal login form, type the work
  // email, get a silent rejection, and email support confused.
  //
  // Fix: provision BOTH emails as client_users members so either
  // address signs them in. ensurePortalUser is idempotent on
  // (client_id, email) UNIQUE — same-email re-calls no-op.
  //
  // See: CertaPro Calgary / Justin Enns incident 2026-06-04 — second
  // post-unlock buyer to hit this exact confusion path.
  const portalEmails = new Set<string>([email.trim().toLowerCase()]);
  const previewFormEmail = await loadPreviewFormEmail(supabase, clientId);
  if (previewFormEmail) {
    portalEmails.add(previewFormEmail.trim().toLowerCase());
  }
  for (const portalEmail of portalEmails) {
    try {
      await ensurePortalUser(supabase, clientId, portalEmail);
    } catch (e) {
      console.warn(
        `[score-unlock] ensurePortalUser threw for ${portalEmail} (non-fatal):`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }
  if (portalEmails.size > 1) {
    console.info(
      `[score-unlock] dual-provisioned portal access for ${clientId}:`,
      [...portalEmails].join(', ')
    );
  }

  // ─── 6. Fire-and-forget side effects ────────────────────────────────
  after(async () => {
    // 6a. AI Coach — the lead-magnet's deferred Claude call. We
    //     skipped it at preview time; runs now that the buyer paid.
    try {
      const insightResult = await generateInsight(
        supabase,
        scanId,
        null,
        { napAuditWaitMs: 90_000 }
      );
      if (!insightResult.ok) {
        console.warn(
          '[score-unlock] AI Coach generation failed',
          scanId,
          insightResult.error
        );
      }
    } catch (e) {
      console.warn(
        '[score-unlock] AI Coach generation threw',
        scanId,
        e instanceof Error ? e.message : String(e)
      );
    }

    // 6b. Confirmation + scan-ready emails — same pair the standard
    //     /api/orders/fulfill flow sends. dashboardUrl points at the
    //     buyer's portal once they magic-link in; sendScanReady's
    //     deep link goes to /share/<id> for the actual scan view
    //     (no magic-link needed — the buyer already has the share
    //     URL from the preview).
    const dashboardUrl = client.public_id
      ? portalUrl(APP_ORIGIN, client.public_id)
      : `${APP_ORIGIN}/share/${shareId}`;
    try {
      await sendOrderConfirmation({
        to: email,
        businessName: client.business_name,
        tier: 'scan',
        dashboardUrl,
        bookingUrl: null,
      });
    } catch (e) {
      console.warn(
        '[score-unlock] sendOrderConfirmation threw',
        e instanceof Error ? e.message : String(e)
      );
    }

    try {
      // ONE-CLICK SIGN-IN. Replaces the previous /share/<id> CTA so
      // the buyer doesn't have to type any email at a login form —
      // they click the email button, land on /portal/<slug> already
      // authenticated. Falls back to /portal/<slug> (login form) if
      // admin.generateLink fails — that path still works because of
      // the dual-email provisioning above.
      //
      // The /share/<id> page would only render the legacy share view
      // (no portal features), so even with no auth we'd rather send
      // the buyer to their portal. public_id is always present on a
      // real client row — we loaded it back in step 2.
      const oneClickUrl = client.public_id
        ? (await buildOneClickPortalUrl(
            supabase,
            email,
            client.public_id,
            APP_ORIGIN
          )) ?? `${APP_ORIGIN}/portal/${client.public_id}`
        : `${APP_ORIGIN}/share/${shareId}`;
      // The scan rows already carry the computed score family —
      // sendScanReady takes a `metrics` blob, not loose fields.
      const reach =
        scan.turf_reach != null ? Number(scan.turf_reach) : null;
      const rank =
        scan.turf_rank != null ? Number(scan.turf_rank) : null;
      const score =
        scan.turf_score != null ? Number(scan.turf_score) : null;
      const metrics =
        score != null && reach != null
          ? {
              turfScore: score,
              turfReach: reach,
              turfRank: rank,
            }
          : undefined;
      await sendScanReady({
        to: email,
        businessName: client.business_name,
        dashboardUrl: oneClickUrl,
        metrics,
      });
    } catch (e) {
      console.warn(
        '[score-unlock] sendScanReady threw',
        e instanceof Error ? e.message : String(e)
      );
    }

    // 6c-pre. Meta CAPI Purchase event. Server-side firing means
    // ad-blockers + iOS Safari ITP can't suppress the conversion —
    // client-side fbq alone misses ~30-50% of real purchases. We
    // dedup against the client-side Pixel that /order/success fires
    // by stamping the same event_id on both sides; Meta matches the
    // pair by (event_name, event_id) within ~48h and counts ONE
    // conversion.
    //
    // The preview lead_orders row (source='score_preview') carries
    // the attribution data we captured at /prove-it form submission:
    // fbclid, utm_*, lead_source. We reuse those here so Meta can
    // match the Purchase back to the ad set that originally drove
    // the click — without it, Meta sees "purchase from unknown
    // origin" and conversion attribution suffers.
    //
    // event_id is also written back to the score_unlock lead_orders
    // row's stripe_metadata so /order/success's MetaPixelTrack can
    // pass the same id to fbq for dedup. WITHOUT the dedup, every
    // converted buyer would count as 2 purchases in Events Manager.
    const metaEventId = randomUUID();
    let metaCapiPurchasePayload: {
      ok: true;
      payload: Parameters<typeof sendMetaCapiEvent>[0];
    } | null = null;
    try {
      // Pull attribution off the original /prove-it preview row.
      // Best-effort: missing fields just mean weaker match quality,
      // not a fatal error. The score_unlock lead_orders row would
      // also work but it has fewer attribution fields than the
      // preview row.
      const { data: previewMetaRow } = await supabase
        .from('lead_orders')
        .select('email, stripe_metadata')
        .eq('client_id', clientId)
        .order('created_at', { ascending: true })
        .limit(10)
        .returns<
          Array<{
            email: string | null;
            stripe_metadata: Record<string, unknown> | null;
          }>
        >();
      const previewRow =
        (previewMetaRow ?? []).find(
          (r) => r.stripe_metadata?.source === 'score_preview'
        ) ?? null;
      const previewMeta = previewRow?.stripe_metadata ?? null;
      const previewPhone =
        previewMeta && typeof previewMeta.phone === 'string'
          ? previewMeta.phone
          : null;
      const fbclidFromAttribution =
        previewMeta && typeof previewMeta.attribution_fbclid === 'string'
          ? previewMeta.attribution_fbclid
          : null;
      const leadSourceFromAttribution =
        previewMeta && typeof previewMeta.lead_source === 'string'
          ? previewMeta.lead_source
          : null;
      const fbc = fbclidFromAttribution
        ? buildFbcFromFbclid(fbclidFromAttribution)
        : null;

      const purchaseValueCents = session.amount_total ?? 4900;
      const customData: Record<string, string | number | boolean> = {
        content_name: 'TurfScan',
        // 'score_unlock' makes this distinguishable from regular
        // /scan/intake direct-checkout purchases in Events Manager.
        // Filter by content_category='score_unlock' to slice
        // /free-score + /prove-it conversion volume specifically.
        content_category: 'score_unlock',
        value: purchaseValueCents / 100,
        currency: 'USD',
      };
      if (leadSourceFromAttribution) {
        customData.lead_source = leadSourceFromAttribution;
      }
      // /share/<id> is the natural "where did this purchase happen"
      // URL — the buyer clicked Unlock from that surface.
      const eventSourceUrl = `${APP_ORIGIN}/share/${shareId}`;

      metaCapiPurchasePayload = {
        ok: true,
        payload: {
          event: 'Purchase',
          eventId: metaEventId,
          eventSourceUrl,
          userData: {
            email,
            phone: previewPhone,
            fbc,
            // fbp can't be reconstructed without the cookie — Meta
            // accepts the event without it, just at lower match
            // quality. /order/success-side client pixel WILL have
            // fbp and we'll send a deduped event from there too
            // (which provides the cookie-based match), so server-
            // side absence is acceptable.
          },
          customData,
        },
      };

      const result = await sendMetaCapiEvent(metaCapiPurchasePayload.payload);
      if (!result.ok && result.reason !== 'not_configured') {
        console.warn(
          '[score-unlock] Meta CAPI Purchase failed:',
          result.reason,
          result.message
        );
      }
    } catch (e) {
      console.warn(
        '[score-unlock] Meta CAPI Purchase threw',
        e instanceof Error ? e.message : String(e)
      );
    }

    // Stamp event_id + attribution onto the score_unlock lead_orders
    // row so /order/success's MetaPixelTrack can fire the matching
    // client-side event with the same id (deduped server↔client).
    try {
      const { data: scoreUnlockOrderForMeta } = await supabase
        .from('lead_orders')
        .select('id, stripe_metadata')
        .eq('stripe_session_id', session.id)
        .maybeSingle<{
          id: string;
          stripe_metadata: Record<string, string> | null;
        }>();
      if (scoreUnlockOrderForMeta) {
        await supabase
          .from('lead_orders')
          .update({
            stripe_metadata: {
              ...(scoreUnlockOrderForMeta.stripe_metadata ?? {}),
              meta_purchase_event_id: metaEventId,
              meta_purchase_value_cents: String(session.amount_total ?? 4900),
              meta_purchase_capi_fired: metaCapiPurchasePayload
                ? 'true'
                : 'false',
            },
          })
          .eq('id', scoreUnlockOrderForMeta.id);
      }
    } catch (e) {
      console.warn(
        '[score-unlock] meta_purchase_event_id stamp failed:',
        e instanceof Error ? e.message : String(e)
      );
    }

    // 6c. Operator Slack ping — surfaces the unlock in #llm-leads
    //     so we know the lead-magnet → paid funnel converted.
    try {
      await notifyTurfScanPurchase({
        businessName: client.business_name,
        tier: 'scan',
        amountCents: session.amount_total ?? 9900,
        coupon: null,
        keyword: primaryKeyword,
        city: client.city ?? '',
        utmSource: 'score_lead_magnet',
        utmContent: null,
        prospectId: null,
        shareUrl: `${APP_ORIGIN}/share/${shareId}`,
      });
    } catch (e) {
      console.warn(
        '[score-unlock] notifyTurfScanPurchase threw',
        e instanceof Error ? e.message : String(e)
      );
    }

    // 6d. Schedule Pulse-trial recovery drip — 2 emails over 72h.
    //
    // The Pulse trial-attach offer is the only remaining upsell
    // recovery lane. The audit-upgrade recovery drip (was 3 emails
    // at T+1h/+8h/+22h) was removed 2026-06-13 per Anthony's
    // page-only upsell policy: the audit upgrade is a strict one-
    // shot on /order/success and expires on decline. Following up
    // on a declined upsell with reopen-link emails directly
    // contradicts the policy.
    //
    // Pulse recovery uses an extended-trial offer (60 days vs the
    // standard 30) with a 72h offer window:
    //   touch_1 at T+48h, touch_2 at T+120h (5 days)
    //
    // The reopen URL round-trips the original Stripe session_id so
    // /order/success can re-hydrate the score_unlock state and re-
    // render the Pulse-attach panel (?reopen=pulse). ?extended=1
    // tells the Pulse-attach route to flip trial_period_days from
    // 30 → 60.
    //
    // Email ids are stamped on the score_unlock lead_orders row's
    // stripe_metadata. The customer.subscription.created webhook
    // reads them back to cancel the drip when Pulse converts.
    try {
      const now = Date.now();
      const HOUR_MS = 60 * 60 * 1000;
      // Pulse-recovery timing — extended-trial offer expires at T+72h.
      const pulseOfferCutoff = new Date(now + 72 * HOUR_MS);
      const pulseT1At = new Date(now + 48 * HOUR_MS);
      const pulseT2At = new Date(now + 120 * HOUR_MS);
      const pulseReopenUrl =
        `${APP_ORIGIN}/order/success` +
        `?tier=scan&session_id=${session.id}&reopen=pulse&extended=1`;

      // Hours-remaining at each compose time, baked into the body
      // copy. Computed from the scheduledAt against the offer cutoff
      // so the numbers stay honest if Resend's scheduled delivery
      // slips by a few minutes.
      const hoursLeftAt = (sentAt: Date, cutoff: Date) =>
        Math.max(1, Math.round((cutoff.getTime() - sentAt.getTime()) / HOUR_MS));

      const pulseT1 = await sendPulseRecovery({
        to: email,
        businessName: client.business_name,
        reopenUrl: pulseReopenUrl,
        stage: 'touch_1',
        hoursRemaining: hoursLeftAt(pulseT1At, pulseOfferCutoff),
        scheduledAt: pulseT1At.toISOString(),
      });
      const pulseT2 = await sendPulseRecovery({
        to: email,
        businessName: client.business_name,
        reopenUrl: pulseReopenUrl,
        stage: 'touch_2',
        hoursRemaining: hoursLeftAt(pulseT2At, pulseOfferCutoff),
        scheduledAt: pulseT2At.toISOString(),
      });

      // Persist the Resend ids on the score_unlock lead_orders row.
      // We look up by stripe_session_id (just inserted in step 3),
      // merge into existing metadata, and write back. Best-effort —
      // a write failure means we can't cancel the emails later when
      // the buyer converts, so they'd receive a recovery email they
      // shouldn't. Not fatal; just noisy.
      const idPatch: Record<string, string> = {};
      if (pulseT1.id) idPatch.pulse_recovery_touch_1_email_id = pulseT1.id;
      if (pulseT2.id) idPatch.pulse_recovery_touch_2_email_id = pulseT2.id;
      idPatch.pulse_recovery_offer_cutoff = pulseOfferCutoff.toISOString();

      if (Object.keys(idPatch).length > 0) {
        const { data: scoreUnlockOrder } = await supabase
          .from('lead_orders')
          .select('id, stripe_metadata')
          .eq('stripe_session_id', session.id)
          .maybeSingle<{
            id: string;
            stripe_metadata: Record<string, string> | null;
          }>();
        if (scoreUnlockOrder) {
          await supabase
            .from('lead_orders')
            .update({
              stripe_metadata: {
                ...(scoreUnlockOrder.stripe_metadata ?? {}),
                ...idPatch,
              },
            })
            .eq('id', scoreUnlockOrder.id);
        }
      }
    } catch (e) {
      console.warn(
        '[score-unlock] Pulse recovery drip scheduling failed:',
        e instanceof Error ? e.message : String(e)
      );
    }
  });
}

/**
 * Falls back to the preview lead_orders.email when the Stripe
 * session doesn't surface a buyer email. Should be rare — Stripe
 * Checkout collects email by default — but defensive.
 */
async function loadPreviewEmail(
  supabase: ReturnType<typeof getServerSupabase>,
  clientId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('lead_orders')
    .select('email')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ email: string | null }>();
  return data?.email ?? null;
}

/**
 * Pull the email the buyer originally typed into the /free-score
 * or /prove-it form. Filtered to the `source='score_preview'` row
 * specifically — by the time the dual-provision step runs, this
 * client also has a `source='score_unlock'` (fulfilled) row whose
 * email is the Stripe-payment email, NOT the form email.
 *
 * Returns null when no preview row exists (a possible state on
 * legacy data or a webhook-retry race). Callers should treat null
 * as "nothing extra to provision" rather than an error.
 */
async function loadPreviewFormEmail(
  supabase: ReturnType<typeof getServerSupabase>,
  clientId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('lead_orders')
    .select('email, stripe_metadata')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })
    .limit(20)
    .returns<
      Array<{
        email: string | null;
        stripe_metadata: Record<string, unknown> | null;
      }>
    >();
  for (const row of data ?? []) {
    const source =
      typeof row.stripe_metadata?.source === 'string'
        ? row.stripe_metadata.source
        : null;
    if (source === 'score_preview' && row.email) {
      return row.email;
    }
  }
  return null;
}

/**
 * Generate a deep-link sign-in URL that signs the buyer into their
 * portal in one click — no email form, no "which email do I use"
 * guesswork. Wraps Supabase admin.generateLink under the same
 * /auth/callback?token_hash=... shape that lib/auth/sendMagicLink
 * uses, so the existing auth-callback handler verifies + redirects
 * to `next` exactly as it does for normal magic-link sign-ins.
 *
 * Default token expiry is OTP_EXPIRY (1 hour on stock Supabase).
 * After expiry, the buyer's click lands on /auth/callback which
 * either shows an "expired link" error or punts them to the
 * standard /portal/<slug>/login form. The dual-email provisioning
 * (step 5) is what makes that fallback graceful — they can sign
 * in with EITHER address they remember.
 *
 * Returns null on any failure (admin call error, missing token).
 * Caller falls back to the bare /portal/<slug> URL — the login form
 * still works, just less magical.
 */
async function buildOneClickPortalUrl(
  supabase: ReturnType<typeof getServerSupabase>,
  email: string,
  publicId: string,
  origin: string
): Promise<string | null> {
  try {
    const next = `/portal/${publicId}`;
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      console.warn(
        '[score-unlock] admin.generateLink failed (falling back to /portal):',
        error.message
      );
      return null;
    }
    const hashedToken = data?.properties?.hashed_token;
    if (!hashedToken) {
      console.warn(
        '[score-unlock] admin.generateLink returned no hashed_token (falling back to /portal)'
      );
      return null;
    }
    const params = new URLSearchParams({
      token_hash: hashedToken,
      type: 'magiclink',
      next,
    });
    return `${origin}/auth/callback?${params.toString()}`;
  } catch (e) {
    console.warn(
      '[score-unlock] buildOneClickPortalUrl threw:',
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}
