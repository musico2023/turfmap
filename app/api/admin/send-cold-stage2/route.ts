/**
 * POST /api/admin/send-cold-stage2
 *
 * Operator endpoint to manually trigger Stage 2 (reply-response scan
 * link delivery) for a cold-email-cohort prospect. This is the
 * Option B (manual review) implementation: Anthony reviews the
 * Instantly Unibox for positive replies, confirms intent, then POSTs
 * here with the prospect_id to send the personalized scan link.
 *
 * Volume guidance: this is fine while reply volume stays <10/day.
 * Above that, replace with an Instantly-webhook-driven NLP classifier
 * that auto-fires for high-confidence positives and queues ambiguous
 * ones to a small Slack approval thread.
 *
 * Auth: bearer token from OPS_ADMIN_SECRET (same pattern other admin
 * endpoints use). The endpoint is intentionally NOT cron-callable —
 * each invocation must be triggered by an operator with the token.
 *
 * Request body:
 *   { "prospect_id": "<uuid>" }
 *
 * Behavior:
 *   1. Look up prospect by ID, verify cohort='cold_email_q2_2026'.
 *   2. Verify prospect has email + first_name (denormalized from
 *      the cold-email push pipeline).
 *   3. Verify stage_2_sent_at IS NULL (don't double-send).
 *   4. Build the personalized scan URL with COLDSCAN coupon.
 *   5. Render + send ColdReplyScanLinkEmail via Resend.
 *   6. UPDATE prospects SET stage_2_sent_at = NOW(),
 *        audit_upgrade_url = <url> (we reuse audit_upgrade_url for
 *        the cold cohort's scan-link URL — same operator-recovery
 *        semantics: the URL the email contained at send time).
 *
 * Idempotency: the stage_2_sent_at IS NULL guard on UPDATE prevents
 * a second send if the operator clicks twice. Returns 409 on a
 * duplicate request.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import ColdReplyScanLinkEmail, {
  COLD_STAGE2_SUBJECT,
} from '@/components/email/ColdReplyScanLinkEmail';

export const runtime = 'nodejs';

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';

function isAuthorized(req: Request): boolean {
  const secret = process.env.OPS_ADMIN_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

function buildScanUrl(origin: string, prospectId: string): string {
  const params = new URLSearchParams();
  params.set('prospect_id', prospectId);
  params.set('coupon', 'COLDSCAN');
  params.set('utm_source', 'cold_email');
  params.set('utm_medium', 'warm_reply');
  params.set('utm_campaign', 'q2_2026');
  return `${origin}/yourmap?${params.toString()}`;
}

// Resolve {{business_name}} in the placeholder subject. Once the brief
// copy lands, the subject template can stop being a merge-field string
// and just be plain text — until then we substitute here.
function resolveSubject(template: string, businessName: string): string {
  return template.replace('{{business_name}}', businessName);
}

type ProspectRow = {
  id: string;
  cohort: string | null;
  business_name: string;
  first_name: string | null;
  email: string | null;
  trade: string | null;
  stage_2_sent_at: string | null;
};

export async function POST(req: Request) {
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

  let body: { prospect_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const prospectId = body.prospect_id?.trim();
  if (!prospectId) {
    return NextResponse.json(
      { error: 'prospect_id required' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const { data: prospect, error } = await supabase
    .from('prospects')
    .select(
      'id, cohort, business_name, first_name, email, trade, stage_2_sent_at'
    )
    .eq('id', prospectId)
    .maybeSingle<ProspectRow>();

  if (error) {
    return NextResponse.json(
      { error: 'supabase_query_failed', message: error.message },
      { status: 500 }
    );
  }
  if (!prospect) {
    return NextResponse.json({ error: 'prospect not found' }, { status: 404 });
  }
  if (prospect.cohort !== 'cold_email_q2_2026') {
    return NextResponse.json(
      { error: `wrong cohort: ${prospect.cohort}` },
      { status: 400 }
    );
  }
  if (!prospect.email || !prospect.first_name) {
    return NextResponse.json(
      { error: 'prospect missing email or first_name' },
      { status: 400 }
    );
  }
  if (prospect.stage_2_sent_at) {
    return NextResponse.json(
      {
        error: 'already_sent',
        stage_2_sent_at: prospect.stage_2_sent_at,
      },
      { status: 409 }
    );
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const scanUrl = buildScanUrl(origin, prospect.id);

  const html = await render(
    ColdReplyScanLinkEmail({
      firstName: prospect.first_name,
      businessName: prospect.business_name,
      trade: prospect.trade ?? 'service contractor',
      scanUrl,
    })
  );

  const resend = new Resend(resendKey);
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: prospect.email,
      subject: resolveSubject(COLD_STAGE2_SUBJECT, prospect.business_name),
      html,
      // Replies route to Anthony — keeps the relational thread on
      // his inbox, not a no-reply.
      replyTo: 'anthony@fourdots.io',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    return NextResponse.json(
      { error: 'resend_send_failed', message },
      { status: 502 }
    );
  }

  // Idempotency stamp. Reuses `audit_upgrade_url` column for operator-
  // recovery (it holds the URL we sent at the time of send, regardless
  // of cohort) — cleaner than adding a parallel cold-only column.
  const { error: updateErr } = await supabase
    .from('prospects')
    .update({
      stage_2_sent_at: new Date().toISOString(),
      audit_upgrade_url: scanUrl,
    })
    .eq('id', prospect.id)
    .is('stage_2_sent_at', null);

  if (updateErr) {
    // Email already sent but stamp failed — log loudly. Re-POSTing
    // returns 409 not_sent because the row's stage_2_sent_at is now
    // either NULL (cleanup needed) or stamped. Worst case operator
    // re-POSTs and gets a duplicate send — accept this rare case
    // over hard-failing the operator at this point.
    console.error('[send-cold-stage2] stamp failed for', prospect.id, updateErr);
    return NextResponse.json(
      {
        ok: true,
        warning: 'email sent but stamp failed',
        stamp_error: updateErr.message,
      },
      { status: 200 }
    );
  }

  return NextResponse.json({
    ok: true,
    prospect_id: prospect.id,
    scan_url: scanUrl,
  });
}
