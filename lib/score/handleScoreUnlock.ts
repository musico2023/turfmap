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
  sendScanReady,
} from '@/lib/email/resend';
import { notifyTurfScanPurchase } from '@/lib/audit/operatorSlack';
import { portalUrl } from '@/lib/urls';
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
  // is_preview=false unhides it everywhere. billing_mode + tier match
  // the standard scan-buyer posture. status='active' so it appears
  // in the operator dashboard. stripe_customer_id captures the
  // Stripe link so future audit-upgrade Checkouts can pre-bind it.
  const { error: clientUpdateErr } = await supabase
    .from('clients')
    .update({
      is_preview: false,
      billing_mode: 'one_time',
      tier: 'scan',
      status: 'active',
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    })
    .eq('id', clientId);
  if (clientUpdateErr) {
    console.error(
      '[score-unlock] client update failed',
      clientId,
      clientUpdateErr.message
    );
    // Don't return — the lead_orders row is in, the unlock is partial
    // but recoverable from the operator side. Let the after()
    // side-effects still fire so the buyer at least gets emails.
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

  // ─── 5. Provision portal access ─────────────────────────────────────
  // Same flow as /api/orders/fulfill — idempotent on the
  // (client_id, email) UNIQUE in client_users.
  try {
    await ensurePortalUser(supabase, clientId, email);
  } catch (e) {
    console.warn(
      '[score-unlock] ensurePortalUser threw (non-fatal):',
      e instanceof Error ? e.message : String(e)
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
      const shareUrl = `${APP_ORIGIN}/share/${shareId}`;
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
        dashboardUrl: shareUrl,
        metrics,
      });
    } catch (e) {
      console.warn(
        '[score-unlock] sendScanReady threw',
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
