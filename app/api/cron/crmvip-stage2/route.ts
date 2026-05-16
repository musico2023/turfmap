/**
 * Vercel Cron — Stage 2 (audit-upgrade) email for the CRM
 * warm-reactivation cohort.
 *
 * Schedule (vercel.json — add this entry alongside the existing
 * crons; this file documents the contract):
 *   "/api/cron/crmvip-stage2"     every 15 min
 *
 * Trigger conditions for each prospect row (all must be true):
 *   - cohort = 'crm_reactivation_q2'
 *   - converted_at IS NOT NULL              (purchased TurfScan)
 *   - scan_engaged_at IS NOT NULL           (viewed dashboard)
 *   - stage_2_sent_at IS NULL               (not sent before)
 *   - NOW() - scan_engaged_at >= 30 min     (let results sink in)
 *   - NOW() - scan_engaged_at <= 24 hr      (respect upgrade window)
 *
 * Per qualifying prospect:
 *   1. Build the audit upgrade URL (auto-applies UPGRADE_302_CREDIT)
 *   2. Render + send the Stage 2 email via Resend
 *   3. UPDATE prospects SET stage_2_sent_at = NOW(),
 *        audit_upgrade_url = <built url>
 *
 * Idempotency: the stage_2_sent_at IS NULL filter + the immediate
 * stage_2_sent_at write on the same row makes this safe even if
 * the cron double-fires (Vercel cron has at-least-once delivery
 * semantics).
 *
 * Silent success: when no prospects qualify, returns 200 with
 * { sent: 0 }. Anthony only sees errors in logs.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel sets this
 * automatically when the env var is configured on the project.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import CrmStage2AuditUpgradeEmail, {
  pickSubject,
} from '@/components/email/CrmStage2AuditUpgradeEmail';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

function buildAuditUpgradeUrl(
  origin: string,
  prospectId: string
): string {
  // The /api/upgrade/audit/create-session endpoint accepts source=
  // 'order_success' | 'dashboard'. For Stage 2 emails we need a
  // third source path that authenticates via prospect_id (the same
  // capability-token model /freescan uses). The endpoint MUST be
  // extended to accept source='stage_2_email' before this URL
  // resolves cleanly — until then this URL will fail validation +
  // route the buyer to the audit pricing page as a fallback.
  //
  // Once the endpoint is extended:
  //   POST /api/upgrade/audit/create-session
  //   body: { source: 'stage_2_email', prospect_id: '<id>' }
  //   server looks up prospects.<id> → finds the Stripe customer
  //   from their TurfScan lead_orders row → creates upgrade
  //   Checkout with UPGRADE_302_CREDIT pre-applied.
  //
  // For now, embed the bootstrapping URL that the email-click
  // handler can POST. Production deploy MUST update the
  // /api/upgrade/audit/create-session route per the spec above.
  const params = new URLSearchParams();
  params.set('source', 'stage_2_email');
  params.set('prospect_id', prospectId);
  return `${origin}/audit-upgrade?${params.toString()}`;
}

type ProspectRow = {
  id: string;
  business_name: string;
  preview_score: number;
  top_competitor_name: string | null;
  email_campaign: string | null;
  // first_name + email aren't in the prospects table base schema.
  // For the CRM cohort, Anthony imports them via the data-migration
  // (see retag_highlevel_import_to_crmvip.py). The Stage 2 mailer
  // looks them up from the prospects-side fields populated by that
  // migration. If the columns don't exist (cold-email cohort), the
  // SELECT below returns null; we skip those rows.
  first_name: string | null;
  email: string | null;
};

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json(
      { error: 'RESEND_API_KEY not configured' },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

  // ─── 1. Find qualifying prospects ─────────────────────────────────
  // Window math runs in JS because Supabase JS client doesn't have
  // a clean INTERVAL helper for the 30 min / 24 hr bounds.
  const nowMs = Date.now();
  const min30AgoIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const hr24AgoIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from('prospects')
    .select(
      'id, business_name, preview_score, top_competitor_name, email_campaign, first_name, email'
    )
    .eq('cohort', 'crm_reactivation_q2')
    .not('converted_at', 'is', null)
    .not('scan_engaged_at', 'is', null)
    .is('stage_2_sent_at', null)
    .lte('scan_engaged_at', min30AgoIso)
    .gte('scan_engaged_at', hr24AgoIso);

  if (error) {
    console.error('[crmvip-stage2] supabase query failed:', error);
    return NextResponse.json(
      { error: 'supabase_query_failed', message: error.message },
      { status: 500 }
    );
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ sent: 0, scanned: 0 });
  }

  // ─── 2. Send each ─────────────────────────────────────────────────
  const resend = new Resend(resendKey);
  let sent = 0;
  const errors: Array<{ prospect_id: string; message: string }> = [];

  for (const p of candidates as ProspectRow[]) {
    if (!p.email || !p.first_name) {
      errors.push({
        prospect_id: p.id,
        message: 'missing first_name or email — skipped',
      });
      continue;
    }
    try {
      const auditUpgradeUrl = buildAuditUpgradeUrl(origin, p.id);
      const band = getTurfScoreBand(p.preview_score).label;
      const html = await render(
        CrmStage2AuditUpgradeEmail({
          firstName: p.first_name,
          businessName: p.business_name,
          turfScoreBand: band,
          topCompetitorName: p.top_competitor_name,
          auditUpgradeUrl,
        })
      );
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: p.email,
        subject: pickSubject(p.id),
        html,
        // Reply-to Anthony directly so warm-cohort replies land in
        // his inbox, not a no-reply.
        replyTo: 'anthony@fourdots.io',
      });
      // Idempotency stamp + persist the URL we sent (operator can
      // re-resolve from logs if Resend has delivery issues).
      const { error: updateErr } = await supabase
        .from('prospects')
        .update({
          stage_2_sent_at: new Date().toISOString(),
          audit_upgrade_url: auditUpgradeUrl,
        })
        .eq('id', p.id)
        .is('stage_2_sent_at', null);
      if (updateErr) {
        // Email already sent but stamp failed — log loudly. Next
        // cron run will re-send unless someone fixes the stamp.
        // Worst case: a small number of dupes; acceptable for a
        // 28-prospect campaign.
        console.error(
          '[crmvip-stage2] stamp failed for',
          p.id,
          updateErr
        );
        errors.push({ prospect_id: p.id, message: updateErr.message });
      }
      sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      console.error('[crmvip-stage2] send failed for', p.id, e);
      errors.push({ prospect_id: p.id, message });
    }
  }

  return NextResponse.json({
    scanned: candidates.length,
    sent,
    errors,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
