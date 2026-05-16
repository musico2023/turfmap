/**
 * Vercel Cron — Stage 3 (free Visibility Audit + calendar booking)
 * email for the COLD-EMAIL reply-driven cohort.
 *
 * Schedule (vercel.json):
 *   "/api/cron/cold-stage3"     every 15 min
 *
 * Trigger conditions for each prospect row (all must be true):
 *   - cohort = 'cold_email_q2_2026'        (reply-driven cold cohort)
 *   - converted_at IS NOT NULL              (purchased/redeemed TurfScan via COLDSCAN)
 *   - scan_engaged_at IS NOT NULL           (viewed dashboard)
 *   - stage_3_sent_at IS NULL               (not sent before)
 *   - NOW() - scan_engaged_at >= 30 min     (let results sink in)
 *   - NOW() - scan_engaged_at <= 24 hr      (respect engagement window)
 *
 * Per qualifying prospect:
 *   1. Render the Stage 3 email (free Visibility Audit + calendar booking)
 *   2. Send via Resend with replyTo Anthony's inbox
 *   3. UPDATE prospects SET stage_3_sent_at = NOW()
 *
 * Idempotency: the stage_3_sent_at IS NULL filter + the immediate
 * stage_3_sent_at write on the same row makes this safe even if
 * the cron double-fires (Vercel cron has at-least-once delivery
 * semantics).
 *
 * Silent success: when no prospects qualify, returns 200 with
 * { sent: 0 }. Anthony only sees errors in logs.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel sets this
 * automatically when the env var is configured on the project.
 *
 * Modeled on /api/cron/crmvip-stage2 (VIP warm-cohort Stage 2). The
 * key difference: the cold cohort's Stage 3 is a free-audit + calendar
 * pitch (no Stripe checkout URL) since these prospects opted in by
 * replying to the cold sequence; pushing a paid audit upgrade at this
 * point breaks the "reply-driven, no transactions" promise.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import ColdStage3AuditOfferEmail, {
  pickSubject as pickStage3Subject,
} from '@/components/email/ColdStage3AuditOfferEmail';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';

// Anthony's existing Cal.com booking link for the Visibility Audit
// walkthrough call. The Stage 3 email CTA points buyers here. If the
// link changes, update this constant — the cron picks up the new URL
// on next render. Do NOT hard-code into the email component; the
// component reads it from props so previews and tests can override.
const CAL_BOOKING_URL =
  process.env.COLD_STAGE3_CAL_URL ??
  'https://cal.com/turfmap.ai/visibility-audit-walkthrough';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

type ProspectRow = {
  id: string;
  business_name: string;
  preview_score: number;
  top_competitor_name: string | null;
  // first_name + email denormalized onto prospects by the cold-email
  // push pipeline (lead-generation/scripts/phase2_push.py). For new
  // pushes on cohort='cold_email_q2_2026' these MUST be populated;
  // skip rows where they aren't.
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

  // ─── 1. Find qualifying prospects ─────────────────────────────────
  const nowMs = Date.now();
  const min30AgoIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const hr24AgoIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from('prospects')
    .select(
      'id, business_name, preview_score, top_competitor_name, first_name, email'
    )
    .eq('cohort', 'cold_email_q2_2026')
    .not('converted_at', 'is', null)
    .not('scan_engaged_at', 'is', null)
    .is('stage_3_sent_at', null)
    .is('unsubscribed_at', null)
    .lte('scan_engaged_at', min30AgoIso)
    .gte('scan_engaged_at', hr24AgoIso);

  if (error) {
    console.error('[cold-stage3] supabase query failed:', error);
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
      const band = getTurfScoreBand(p.preview_score).label;
      const html = await render(
        ColdStage3AuditOfferEmail({
          firstName: p.first_name,
          businessName: p.business_name,
          turfScoreBand: band,
          topCompetitorName: p.top_competitor_name,
          calBookingUrl: CAL_BOOKING_URL,
        })
      );
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: p.email,
        subject: pickStage3Subject(p.id),
        html,
        // Replies route to Anthony's inbox — this is a relational
        // pitch, not a no-reply automation.
        replyTo: 'anthony@fourdots.io',
      });
      // Idempotency stamp.
      const { error: updateErr } = await supabase
        .from('prospects')
        .update({ stage_3_sent_at: new Date().toISOString() })
        .eq('id', p.id)
        .is('stage_3_sent_at', null);
      if (updateErr) {
        console.error(
          '[cold-stage3] stamp failed for',
          p.id,
          updateErr
        );
        errors.push({ prospect_id: p.id, message: updateErr.message });
      }
      sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      console.error('[cold-stage3] send failed for', p.id, e);
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
