/**
 * Vercel Cron — Stage 3 (free Visibility Audit + calendar booking)
 * email for the COLD-EMAIL reply-driven cohort.
 *
 * Schedule (vercel.json):  every 15 min, all day
 *                          (the in-code business-hours gate below
 *                           is the authoritative filter)
 *
 * Business-hours gate: Stage 3 only fires Mon-Fri 10am-5pm America/Toronto.
 * Outside that window, the cron returns early with a "skipped: outside
 * business hours" response. Why: this is a relational pitch from Anthony's
 * personal Gmail — sending overnight or weekends reads as a bot and
 * undermines the founder-tone handoff. The cron schedule itself stays
 * every-15-min so we don't miss a same-day fire when the window opens.
 *
 * Trigger conditions for each prospect row (all must be true):
 *   - cohort = 'cold_email_q2_2026'        (reply-driven cold cohort)
 *   - converted_at IS NOT NULL              (purchased/redeemed TurfScan via COLDSCAN)
 *   - scan_engaged_at IS NOT NULL           (viewed dashboard)
 *   - stage_3_sent_at IS NULL               (not sent before)
 *   - unsubscribed_at IS NULL               (didn't opt out via reply)
 *   - NOW() - scan_engaged_at >= 30 min     (let results sink in)
 *   - NOW() - scan_engaged_at <= 72 hr      (covers off-hours engagement)
 *
 * Why 72hr upper bound (not 24hr): the cron is gated to Mon-Fri 10am-5pm
 * America/Toronto so the founder-tone send doesn't read as a bot. With a
 * 24hr ceiling, a buyer who engaged Friday 6pm would be 64+ hours past
 * scan_engaged_at by Monday 10am and silently skipped. 72hr ensures any
 * weekend-or-evening engagement still catches Monday morning's first
 * fire. The 30min lower bound and idempotency (stage_3_sent_at) are
 * unchanged.
 *
 * Per qualifying prospect:
 *   1. Render the Stage 3 email (free Visibility Audit + calendar).
 *   2. Send via Gmail SMTP using anthony@fourdots.io + GMAIL_APP_PASSWORD.
 *   3. UPDATE prospects SET stage_3_sent_at = NOW().
 *
 * Idempotency: stage_3_sent_at IS NULL filter + immediate stamp on the
 * same row. Safe across Vercel cron at-least-once delivery.
 *
 * Auth: Bearer ${CRON_SECRET}, set automatically by Vercel.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import nodemailer from 'nodemailer';
import { render } from '@react-email/components';
import ColdStage3AuditOfferEmail, {
  pickSubject as pickStage3Subject,
} from '@/components/email/ColdStage3AuditOfferEmail';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Sender identity (the From: header + Reply-To). This is the
// fourdots.io alias on Anthony's fourdots.ca Gmail account.
const FROM_NAME = 'Anthony Alfonsi';
const FROM_EMAIL = 'anthony@fourdots.io';
const REPLY_TO = 'anthony@fourdots.io';

// SMTP authentication user — must be the PRIMARY Gmail account, not
// the alias. Anthony's primary inbox is anthony@fourdots.ca with
// anthony@fourdots.io configured under Settings → Accounts → "Send
// mail as." Gmail accepts the alias on the From: header at send time
// but only if the auth user is the primary. Override via GMAIL_USER
// env var if the primary ever changes.
const SMTP_AUTH_USER_DEFAULT = 'anthony@fourdots.ca';

// Anthony's existing Cal.com booking link.
const CAL_BOOKING_URL =
  process.env.COLD_STAGE3_CAL_URL ??
  'https://cal.com/turfmap.ai/visibility-audit-walkthrough';

// Business-hours window. Currently Mon-Fri 10am-5pm America/Toronto.
// Implemented via Intl.DateTimeFormat so DST shifts handle automatically
// (no need to update cron expressions twice a year).
const BUSINESS_HOURS_TZ = 'America/Toronto';
const BUSINESS_HOURS_START = 10; // inclusive
const BUSINESS_HOURS_END = 17;   // exclusive (so 5pm fires the 4:45pm tick but not the 5:00pm tick)

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

function isWithinBusinessHours(now: Date): { ok: true } | { ok: false; reason: string } {
  // Use Intl to read weekday + hour in the target TZ — DST-safe.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_HOURS_TZ,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const hour = parseInt(hourStr, 10);
  // Mon-Fri only.
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) {
    return { ok: false, reason: `weekend (${weekday})` };
  }
  if (hour < BUSINESS_HOURS_START || hour >= BUSINESS_HOURS_END) {
    return { ok: false, reason: `outside hours (${weekday} ${hour}:00 ${BUSINESS_HOURS_TZ})` };
  }
  return { ok: true };
}

type ProspectRow = {
  id: string;
  business_name: string;
  preview_score: number;
  top_competitor_name: string | null;
  first_name: string | null;
  email: string | null;
  trade: string | null;
};

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Business-hours gate — early return outside the window.
  const bh = isWithinBusinessHours(new Date());
  if (!bh.ok) {
    return NextResponse.json({ sent: 0, skipped: bh.reason });
  }

  const gmailUser = process.env.GMAIL_USER ?? SMTP_AUTH_USER_DEFAULT;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailPass) {
    return NextResponse.json(
      { error: 'GMAIL_APP_PASSWORD not configured' },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();

  // Find qualifying prospects.
  const nowMs = Date.now();
  const min30AgoIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
  // Upper bound: 72hr (3 days). Wider than the 24hr default because the
  // cron is business-hours-gated — see header note for the weekend-engage
  // case.
  const hr72AgoIso = new Date(nowMs - 72 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from('prospects')
    .select(
      'id, business_name, preview_score, top_competitor_name, first_name, email, trade'
    )
    .eq('cohort', 'cold_email_q2_2026')
    .not('converted_at', 'is', null)
    .not('scan_engaged_at', 'is', null)
    .is('stage_3_sent_at', null)
    .is('unsubscribed_at', null)
    // Halt gate (migration 0033) — when set, the operator is handling
    // the audit pitch personably in-thread (auto-flipped by
    // poll-replies on a post-Stage-2 reply, or manually flipped via
    // /api/admin/disable-cold-stage3). Either way, the cron skips.
    .is('stage_3_disabled_at', null)
    .lte('scan_engaged_at', min30AgoIso)
    .gte('scan_engaged_at', hr72AgoIso);

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

  // Gmail SMTP transport.
  // Using port 465 with SSL is the most reliable in serverless — 587
  // STARTTLS sometimes has TLS-handshake timing issues on Vercel.
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: gmailUser,
      pass: gmailPass,
    },
  });

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
          // Fallback "service contractor" so the trade-vertical line
          // still reads sensibly if phase2_push didn't classify the
          // prospect (older rows pre-derive_trade(), edge cases).
          trade: p.trade ?? 'service contractor',
          turfScoreBand: band,
          topCompetitorName: p.top_competitor_name,
          calBookingUrl: CAL_BOOKING_URL,
        })
      );
      const subject = pickStage3Subject(p.id, p.first_name);

      await transport.sendMail({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: p.email,
        subject,
        html,
        replyTo: REPLY_TO,
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
    window: BUSINESS_HOURS_TZ,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
