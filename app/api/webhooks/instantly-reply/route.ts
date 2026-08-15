/**
 * POST /api/webhooks/instantly-reply
 *
 * Instantly fires this when a cold-cohort prospect replies in-thread.
 * We classify the reply intent with Claude Haiku, then:
 *
 *   - Positive ("yes", "send it", "sure", etc.):
 *       Schedule the Stage 2 (reply-response scan-link) email for
 *       NOW + 11 minutes via Resend's scheduledAt. The 11-min delay
 *       is intentional — instant auto-replies feel bot-like; an 11-min
 *       beat reads like Anthony is at his keyboard. Idempotent: if
 *       Stage 2 was already sent or scheduled, we 200 with action='noop'.
 *
 *   - Negative ("pass", "no", "remove me", "unsubscribe"):
 *       Stamp prospects.unsubscribed_at and skip downstream emails.
 *
 *   - Ambiguous (anything else):
 *       Forward the reply to anthony@fourdots.io via Resend with an
 *       "[review] ambiguous reply" subject so Anthony can manually
 *       POST /api/admin/send-cold-stage2 if he wants to proceed.
 *
 * Auth: a static token in the URL query string (?token=...). Instantly's
 * webhook config doesn't sign payloads, so the token-in-URL is our
 * only line of defense against random POSTs. Token lives in env var
 * INSTANTLY_WEBHOOK_TOKEN.
 *
 * Cohort scope: this handler ONLY processes replies from prospects
 * with cohort='cold_email_q2_2026'. Other cohorts get 200 + ignored.
 *
 * Instantly webhook payload shape (reverse-engineered — Instantly's
 * docs are incomplete; we parse defensively):
 *   {
 *     "event_type": "reply_received" | "email_replied" | ...,
 *     "lead_email": "buyer@example.com",
 *     "campaign_id": "...",
 *     "reply_subject": "...",
 *     "reply_text_snippet": "first ~500 chars of the reply body",
 *     ...
 *   }
 * Field names vary by Instantly version. We accept several aliases.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { getAnthropic } from '@/lib/anthropic/client';
import ColdReplyScanLinkEmail, {
  COLD_STAGE2_SUBJECT,
} from '@/components/email/ColdReplyScanLinkEmail';
import { fireReplyFanout } from '@/lib/analytics/replyFanout';

export const runtime = 'nodejs';
export const maxDuration = 30;

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';
const OPERATOR_INBOX = 'anthony@fourdots.io';

// The 10-12 min delay window from the brief. We pick 11 — feels
// human, doesn't blow past the buyer's attention window.
const STAGE_2_DELAY_MIN = 11;

// Campaign ID for the cold-email campaign. Should match
// `scripts/phase2_push.py` TARGET_CAMPAIGN_ID. If we run multiple
// cold campaigns later, swap this for a cohort lookup off the
// reply's campaign_id.
const COLD_CAMPAIGN_ID = 'ca462076-74b8-4507-8d2e-f0d1d0a19055';

type Intent = 'positive' | 'negative' | 'ambiguous';

function isAuthorized(req: Request): boolean {
  const token = process.env.INSTANTLY_WEBHOOK_TOKEN;
  if (!token) return false;
  const url = new URL(req.url);
  return url.searchParams.get('token') === token;
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

function resolveSubject(template: string, businessName: string): string {
  return template.replace('{{business_name}}', businessName);
}

async function classifyIntent(replyText: string): Promise<Intent> {
  // Cheap heuristic first — catches the common cases without an API call.
  const norm = replyText.toLowerCase().trim().slice(0, 500);
  // Strong positive signals
  if (/^(yes|yeah|yep|yup|sure|ok|okay|send( it)?|please send|i'?ll take it|let'?s do it|go ahead|sounds good)\b/i.test(norm)) {
    return 'positive';
  }
  // Strong negative signals
  if (/\b(unsubscribe|remove me|stop|opt[\s-]?out|not interested|no thanks|no thank you|pass|leave me alone|fuck off)\b/i.test(norm)) {
    return 'negative';
  }
  // Use Claude Haiku for the rest. ~10ms latency, ~$0.0001 per call.
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      system:
        'You classify cold-email replies for a B2B outreach campaign. ' +
        'The cold email asked the recipient to reply "yes" if they want ' +
        'a free Google Maps geo-grid scan of their business. ' +
        'Return EXACTLY one of these three words (no punctuation, no explanation): ' +
        'positive (recipient wants the scan), ' +
        'negative (recipient declined or wants to unsubscribe), or ' +
        'ambiguous (asking a question, asking for more info, unclear intent, ' +
        'or an out-of-office reply).',
      messages: [
        { role: 'user', content: replyText.slice(0, 2000) },
      ],
    });
    const out = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
      .toLowerCase();
    if (out.startsWith('positive')) return 'positive';
    if (out.startsWith('negative')) return 'negative';
    return 'ambiguous';
  } catch (e) {
    console.error('[instantly-reply] classifier failed:', e);
    // Fail closed: route to Anthony for manual review.
    return 'ambiguous';
  }
}

type ProspectRow = {
  id: string;
  cohort: string | null;
  business_name: string;
  first_name: string | null;
  email: string | null;
  trade: string | null;
  stage_2_sent_at: string | null;
  unsubscribed_at?: string | null;
};

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Defensive field extraction — Instantly's payload shape varies.
  const replyEmail = String(
    body.lead_email ?? body.lead ?? body.email ?? body.from_email ?? ''
  )
    .toLowerCase()
    .trim();
  const replyText = String(
    body.reply_text_snippet ??
      body.reply_text ??
      body.reply ??
      body.body_text ??
      body.text ??
      ''
  );
  const eventType = String(body.event_type ?? body.type ?? '');

  // Only process reply-received events. Other event types (open, click,
  // bounce, etc.) get a silent 200.
  if (
    eventType &&
    !/repl(y|ied)|message_received/i.test(eventType)
  ) {
    return NextResponse.json({ ok: true, ignored: `event_type=${eventType}` });
  }
  if (!replyEmail) {
    return NextResponse.json({ ok: true, ignored: 'no lead_email' });
  }

  const supabase = getServerSupabase();

  // ─── 1. Resolve prospect ──────────────────────────────────────────
  const { data: prospect } = await supabase
    .from('prospects')
    .select(
      'id, cohort, business_name, first_name, email, trade, stage_2_sent_at, unsubscribed_at'
    )
    .ilike('email', replyEmail)
    .eq('cohort', 'cold_email_q2_2026')
    .maybeSingle<ProspectRow>();

  if (!prospect) {
    // Not a cold-cohort prospect — silently ignore.
    return NextResponse.json({ ok: true, ignored: 'not cold-cohort' });
  }

  // ─── 2. Idempotency: skip if Stage 2 already sent/scheduled ───────
  if (prospect.stage_2_sent_at) {
    return NextResponse.json({
      ok: true,
      action: 'noop',
      reason: 'stage_2 already stamped',
    });
  }
  if (prospect.unsubscribed_at) {
    return NextResponse.json({
      ok: true,
      action: 'noop',
      reason: 'already unsubscribed',
    });
  }

  // ─── 3. Classify intent ───────────────────────────────────────────
  const intent = await classifyIntent(replyText);

  // v2.2 P0.2d fanout — fire-and-forget event log + #llm-leads Slack ping +
  // (on positive) GHL opportunity move to Hot stage. Runs independently of
  // downstream stage-2 scheduling; failures never affect the reply flow.
  fireReplyFanout({
    prospect_id: prospect.id,
    business_name: prospect.business_name,
    trade: prospect.trade,
    email: prospect.email,
    intent,
    reply_text_snippet: replyText,
  });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json(
      { error: 'RESEND_API_KEY not configured' },
      { status: 503 }
    );
  }
  const resend = new Resend(resendKey);

  // ─── 4. Negative — mark unsubscribed, no email ────────────────────
  if (intent === 'negative') {
    await supabase
      .from('prospects')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('id', prospect.id)
      .is('unsubscribed_at', null);
    return NextResponse.json({
      ok: true,
      action: 'marked_unsubscribed',
      prospect_id: prospect.id,
    });
  }

  // ─── 5. Ambiguous — forward to Anthony for manual handling ────────
  if (intent === 'ambiguous') {
    const subject = `[review] ambiguous cold-email reply — ${prospect.business_name}`;
    const previewBody = `
      <p><strong>Prospect:</strong> ${prospect.business_name}
         (id: <code>${prospect.id}</code>)</p>
      <p><strong>From:</strong> ${prospect.email}</p>
      <p><strong>Reply:</strong></p>
      <blockquote style="border-left: 3px solid #c5ff3a; padding-left: 12px;
                          margin: 0; color: #71717a; white-space: pre-wrap;">${escapeHtml(
                            replyText.slice(0, 2000)
                          )}</blockquote>
      <p style="margin-top: 16px;">To send Stage 2 anyway:</p>
      <pre style="background: #0a0a0a; padding: 12px; border-radius: 6px;
                   color: #e4e4e7; font-size: 12px; overflow-x: auto;">curl -X POST https://www.turfmap.ai/api/admin/send-cold-stage2 \\
  -H "Authorization: Bearer $OPS_ADMIN_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"prospect_id": "${prospect.id}"}'</pre>
    `;
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: OPERATOR_INBOX,
        subject,
        html: previewBody,
      });
    } catch (e) {
      console.error('[instantly-reply] ambiguous-forward send failed', e);
    }
    return NextResponse.json({
      ok: true,
      action: 'forwarded_to_operator',
      prospect_id: prospect.id,
    });
  }

  // ─── 6. Positive — schedule Stage 2 for NOW + 11 min ──────────────
  if (!prospect.email || !prospect.first_name) {
    return NextResponse.json({
      ok: false,
      error: 'prospect missing email or first_name',
    });
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
  const scheduledAtIso = new Date(
    Date.now() + STAGE_2_DELAY_MIN * 60 * 1000
  ).toISOString();
  try {
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: prospect.email,
      subject: resolveSubject(COLD_STAGE2_SUBJECT, prospect.business_name),
      html,
      replyTo: OPERATOR_INBOX,
      scheduledAt: scheduledAtIso,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    console.error('[instantly-reply] scheduled send failed', e);
    return NextResponse.json(
      { error: 'resend_schedule_failed', message },
      { status: 502 }
    );
  }

  // Stamp early so a retry of the webhook doesn't double-schedule.
  await supabase
    .from('prospects')
    .update({
      stage_2_sent_at: scheduledAtIso, // we treat "scheduled" as sent for idempotency
      audit_upgrade_url: scanUrl,
    })
    .eq('id', prospect.id)
    .is('stage_2_sent_at', null);

  return NextResponse.json({
    ok: true,
    action: 'scheduled_stage_2',
    prospect_id: prospect.id,
    deliver_at: scheduledAtIso,
    delay_minutes: STAGE_2_DELAY_MIN,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
