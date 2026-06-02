/**
 * POST /api/admin/requeue-stale-drips
 *
 * One-off remediation: re-queues the touch_2 + touch_3 unlock-drip
 * emails for Meta-cohort preview signups whose drip was scheduled
 * BEFORE the MAPCHECK50 price-sync commit (81854ce) shipped on
 * 2026-06-01.
 *
 * Resend stores scheduled emails as pre-rendered HTML — changing the
 * template after-the-fact doesn't update queued sends. Affected rows
 * have leadSource='free_score' or 'prove_it' but their queued touch
 * 2/3 HTML still names the $99 list price. This endpoint cancels
 * those stale sends and re-queues fresh ones with the corrected
 * $49 + MAPCHECK50 framing.
 *
 * Touch 1 fired immediately at signup time so it's already in the
 * buyer's inbox — we can't undo it. Only touch 2 (+24h) and touch 3
 * (+72h) are re-queueable. Slots that are already past the
 * scheduled time are silently skipped (Resend will have sent them
 * already, or they're imminent enough that cancellation won't take).
 *
 * Lives at /api/admin/ as a sibling of /admin/send-cold-stage2 —
 * same Bearer auth pattern. The route file is short-lived; delete
 * it once the remediation has run successfully.
 *
 * Auth: Authorization: Bearer $OPS_ADMIN_SECRET
 *
 * Query params:
 *   dry_run=1     — preview which rows would be touched, no writes
 *
 * Run:
 *   curl -X POST 'https://www.turfmap.ai/api/admin/requeue-stale-drips?dry_run=1' \
 *     -H "Authorization: Bearer $OPS_ADMIN_SECRET"
 *
 * Idempotent — running twice cancels what the first run queued and
 * replaces with another fresh pair. Wasteful but harmless.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  sendScoreUnlockNudge,
  cancelScheduledEmail,
} from '@/lib/email/resend';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { isDiscountedLeadSource } from '@/lib/score/leadSources';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Resend's default API rate limit is 5 req/sec. The remediation
 *  fires up to 4 calls per row (cancel T2 + send T2 + cancel T3 +
 *  send T3) and we may have 4+ rows — that's >16 calls if run flat
 *  out, well over the limit. A 250ms throttle keeps us at ~4 calls/sec,
 *  comfortably under the cap with headroom for clock jitter. */
const RESEND_THROTTLE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PRICE_FIX_DEPLOYED_AT = new Date('2026-06-01T22:30:00Z');

function isAuthorized(req: Request): boolean {
  // Accept either OPS_ADMIN_SECRET or CRON_SECRET — both are Bearer-
  // token-class env vars used elsewhere in the codebase for admin /
  // automation paths. CRON_SECRET is non-Sensitive in our Vercel
  // config (operator can copy its value from the dashboard), so it's
  // the practical fallback for one-off remediation curls when
  // OPS_ADMIN_SECRET is flagged Sensitive and therefore unreadable.
  const header = req.headers.get('authorization') ?? '';
  for (const envName of ['OPS_ADMIN_SECRET', 'CRON_SECRET']) {
    const secret = process.env[envName];
    if (secret && header === `Bearer ${secret}`) return true;
  }
  return false;
}

type LeadOrderRow = {
  id: string;
  email: string;
  client_id: string;
  stripe_metadata: Record<string, unknown> | null;
  created_at: string;
};

type TouchResult = {
  old_id: string | null;
  scheduled_for: string;
  in_past: boolean;
  cancelled: boolean;
  new_id: string | null;
  /** Resend error message when the new send failed. Surfaces
   *  reasons like "Recipient is on suppression list" without
   *  forcing a Vercel-logs dive. */
  error?: string;
};

type RowResult = {
  email: string;
  business_name: string | null;
  lead_source: string;
  turf_score: number | null;
  t2: TouchResult;
  t3: TouchResult;
  metadata_updated: boolean;
};

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry_run') === '1';

  const supabase = getServerSupabase();

  const { data: rows, error } = await supabase
    .from('lead_orders')
    .select('id, email, client_id, stripe_metadata, created_at')
    .eq('tier', 'scan')
    .lt('created_at', PRICE_FIX_DEPLOYED_AT.toISOString())
    .returns<LeadOrderRow[]>();

  if (error) {
    return NextResponse.json(
      { error: 'lead_orders query failed', detail: error.message },
      { status: 500 }
    );
  }

  // Filter in JS: source='score_preview' AND lead_source ∈ discount set.
  // Doing this via PostgREST JSONB filter is fiddly + the candidate
  // pool is tiny.
  const affected = (rows ?? []).filter((r) => {
    const meta = r.stripe_metadata ?? {};
    const source = meta.source;
    const leadSource = meta.lead_source;
    return (
      source === 'score_preview' &&
      typeof leadSource === 'string' &&
      isDiscountedLeadSource(leadSource)
    );
  });

  const results: RowResult[] = [];

  for (const row of affected) {
    const meta = row.stripe_metadata ?? {};
    const oldT2 = (meta.unlock_touch_2_email_id as string | undefined) ?? null;
    const oldT3 = (meta.unlock_touch_3_email_id as string | undefined) ?? null;
    const leadSource = meta.lead_source as string;
    const keyword = (meta.keyword as string | undefined) ?? null;

    const { data: client } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('id', row.client_id)
      .maybeSingle<{ id: string; business_name: string }>();

    const { data: scan } = await supabase
      .from('scans')
      .select('id, turf_score')
      .eq('client_id', row.client_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; turf_score: number | null }>();

    const { data: shareLink } = scan
      ? await supabase
          .from('scan_share_links')
          .select('id')
          .eq('scan_id', scan.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<{ id: string }>()
      : { data: null };

    if (!client || !scan || !shareLink) {
      results.push({
        email: row.email,
        business_name: client?.business_name ?? null,
        lead_source: leadSource,
        turf_score: null,
        t2: {
          old_id: oldT2,
          scheduled_for: '',
          in_past: false,
          cancelled: false,
          new_id: null,
        },
        t3: {
          old_id: oldT3,
          scheduled_for: '',
          in_past: false,
          cancelled: false,
          new_id: null,
        },
        metadata_updated: false,
      });
      continue;
    }

    const turfScore = scan.turf_score;
    const band =
      typeof turfScore === 'number'
        ? getTurfScoreBand(turfScore)
        : null;
    const origin = url.origin; // prod domain — used so links survive forever
    const previewUrl = `${origin}/share/${shareLink.id}?utm_source=score_drip`;

    const origCreated = new Date(row.created_at).getTime();
    const scheduledT2 = new Date(origCreated + 24 * 60 * 60 * 1000).toISOString();
    const scheduledT3 = new Date(origCreated + 72 * 60 * 60 * 1000).toISOString();
    const now = Date.now();
    const t2InPast = new Date(scheduledT2).getTime() <= now;
    const t3InPast = new Date(scheduledT3).getTime() <= now;

    const result: RowResult = {
      email: row.email,
      business_name: client.business_name,
      lead_source: leadSource,
      turf_score: turfScore,
      t2: {
        old_id: oldT2,
        scheduled_for: scheduledT2,
        in_past: t2InPast,
        cancelled: false,
        new_id: null,
      },
      t3: {
        old_id: oldT3,
        scheduled_for: scheduledT3,
        in_past: t3InPast,
        cancelled: false,
        new_id: null,
      },
      metadata_updated: false,
    };

    if (dryRun) {
      results.push(result);
      continue;
    }

    // ─── Cancel old IDs (Resend treats "not found" / "already sent" as ok)
    //
    // Every Resend call is preceded by a throttle wait to stay under
    // the 5 req/sec limit. Resend's API returns 429 with the message
    // "Too many requests..." when exceeded and the new schedule
    // silently drops, which is what bit us on the first remediation
    // pass (Hect T3 + Real Flowers T3 lost their replacements).
    if (oldT2) {
      await sleep(RESEND_THROTTLE_MS);
      result.t2.cancelled = await cancelScheduledEmail(oldT2);
    }
    if (oldT3) {
      await sleep(RESEND_THROTTLE_MS);
      result.t3.cancelled = await cancelScheduledEmail(oldT3);
    }

    // ─── Re-queue touch 2 ─────────────────────────────────────────────
    if (!t2InPast) {
      await sleep(RESEND_THROTTLE_MS);
      const t2 = await sendScoreUnlockNudge({
        to: row.email,
        businessName: client.business_name,
        keyword,
        turfScore,
        turfBand: band?.label ?? null,
        previewUrl,
        stage: 'touch_2',
        scheduledAt: scheduledT2,
        leadSource,
      });
      result.t2.new_id = t2.id ?? null;
      if (!t2.ok && t2.error) result.t2.error = t2.error;
    }

    // ─── Re-queue touch 3 ─────────────────────────────────────────────
    if (!t3InPast) {
      await sleep(RESEND_THROTTLE_MS);
      const t3 = await sendScoreUnlockNudge({
        to: row.email,
        businessName: client.business_name,
        keyword,
        turfScore,
        turfBand: band?.label ?? null,
        previewUrl,
        stage: 'touch_3',
        scheduledAt: scheduledT3,
        leadSource,
      });
      result.t3.new_id = t3.id ?? null;
      if (!t3.ok && t3.error) result.t3.error = t3.error;
    }

    // ─── Stamp new IDs on lead_orders.stripe_metadata ────────────────
    const updatedMeta: Record<string, unknown> = { ...meta };
    if (result.t2.new_id) updatedMeta.unlock_touch_2_email_id = result.t2.new_id;
    if (result.t3.new_id) updatedMeta.unlock_touch_3_email_id = result.t3.new_id;
    updatedMeta.unlock_drip_requeued_at = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from('lead_orders')
      .update({ stripe_metadata: updatedMeta })
      .eq('id', row.id);
    result.metadata_updated = !updateErr;

    results.push(result);
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    cutoff: PRICE_FIX_DEPLOYED_AT.toISOString(),
    affected_count: affected.length,
    results,
  });
}
