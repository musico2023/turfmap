/**
 * Vercel Cron — Poll Instantly for cold-cohort replies, classify
 * intent with Claude Haiku, and act.
 *
 * Schedule (vercel.json):  every 2 minutes  (cron "* /2 * * * *" — no spaces in actual cron)
 *
 * Why polling instead of Instantly webhooks: Instantly's webhook
 * feature is gated behind their Hyper Growth plan tier. Anthony's
 * current tier doesn't have it. The /api/webhooks/instantly-reply
 * endpoint exists and is ready to use the moment Hyper Growth is
 * enabled (or for manual operator triggers); until then, this cron
 * does the same job via pull.
 *
 * Trade-off: ~2 min average latency vs instant webhook push. For
 * the 10-12 min downstream delay the brief specifies, this is fine —
 * the prospect's reply still gets a response in <15 min total.
 *
 * Flow per cron tick:
 *   1. GET /api/v2/leads/list filtered to email_reply_count > 0
 *      in the cold-email campaign.
 *   2. For each lead → match to prospects table by email +
 *      cohort='cold_email_q2_2026'.
 *   3. Skip if already processed (stage_2_sent_at IS NOT NULL
 *      OR unsubscribed_at IS NOT NULL).
 *   4. Fetch the latest inbound (ue_type=2) email body via
 *      /api/v2/emails search.
 *   5. Classify intent with Claude Haiku (positive/negative/
 *      ambiguous). Out-of-office replies are classified as
 *      ambiguous so they don't auto-trigger Stage 2.
 *   6. Act:
 *        positive  → schedule Stage 2 (reply-response scan link)
 *                     for NOW + 11 min via Resend scheduledAt.
 *        negative  → stamp unsubscribed_at; skip all downstream.
 *        ambiguous → forward to anthony@fourdots.io for review.
 *      All paths stamp stage_2_sent_at OR unsubscribed_at so
 *      subsequent ticks skip this prospect.
 *
 * Idempotency: the stage_2_sent_at IS NULL / unsubscribed_at IS NULL
 * filters + immediate stamping on the same tick. Safe across
 * Vercel cron at-least-once delivery.
 *
 * Auth: Bearer ${CRON_SECRET}, set automatically by Vercel.
 *
 * Cost per tick (typical):
 *   - 1 Instantly leads/list call (free)
 *   - 0-3 Instantly emails-list calls per reply (free)
 *   - 0-3 Claude Haiku classifications (~$0.0001 each)
 *   - 0-3 Resend scheduled-send calls (Resend tier-dependent)
 *
 * Worst case at 720 ticks/day × ~2 replies/day = ~1440 Instantly
 * API calls/day. Instantly's rate limit on free tier is well above
 * that.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { getAnthropic } from '@/lib/anthropic/client';
import ColdReplyScanLinkEmail, {
  COLD_STAGE2_SUBJECT,
} from '@/components/email/ColdReplyScanLinkEmail';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';
const OPERATOR_INBOX = 'anthony@fourdots.io';
const STAGE_2_DELAY_MIN = 11;

// Campaign IDs that count as the cold-email cohort. Add new IDs if
// the cohort spans multiple campaigns later.
const COLD_CAMPAIGN_IDS = ['ca462076-74b8-4507-8d2e-f0d1d0a19055'];

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type Intent = 'positive' | 'negative' | 'ambiguous';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
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

function resolveSubject(template: string, businessName: string): string {
  return template.replace('{{business_name}}', businessName);
}

async function classifyIntent(replyText: string): Promise<Intent> {
  const norm = replyText.toLowerCase().trim().slice(0, 500);
  // Out-of-office heuristic — strong signal, route to ambiguous so
  // we don't auto-send Stage 2 while the recipient is away.
  if (
    /\b(out of office|on vacation|away from|i am away|absence alert|auto[\s-]?reply|on leave|holiday|will be away|return on|i'?ll be back)\b/i.test(
      norm
    )
  ) {
    return 'ambiguous';
  }
  // Strong positive — match brief's wording set.
  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|send( it)?|please send|i'?ll take it|let'?s do it|go ahead|sounds good)\b/i.test(
      norm
    )
  ) {
    return 'positive';
  }
  // Strong negative.
  if (
    /\b(unsubscribe|remove me|stop|opt[\s-]?out|not interested|no thanks|no thank you|^pass\b|leave me alone)\b/i.test(
      norm
    )
  ) {
    return 'negative';
  }
  // Otherwise → Claude Haiku.
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
        'negative (recipient declined, said pass, wants to unsubscribe), or ' +
        'ambiguous (asking a question, asking for more info, unclear intent, ' +
        'out-of-office reply, or asking to talk later).',
      messages: [{ role: 'user', content: replyText.slice(0, 2000) }],
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
    console.error('[instantly-poll] Haiku classifier failed:', e);
    return 'ambiguous'; // fail closed
  }
}

type InstantlyLead = {
  id: string;
  email: string;
  email_reply_count?: number;
  campaign?: string;
  timestamp_last_reply?: string;
};

type InstantlyEmail = {
  id: string;
  ue_type: number; // 1=outbound, 2=inbound
  from_address_email: string;
  to_address_email_list: string;
  subject: string;
  body?: { text?: string };
  timestamp_email: string;
};

async function instantlyFetch<T>(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${INSTANTLY_BASE}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    throw new Error(`Instantly ${path} HTTP ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as T;
}

async function fetchLatestInboundBody(
  apiKey: string,
  leadEmail: string
): Promise<string | null> {
  // Use the search-by-recipient/from path; Instantly's emails endpoint
  // includes the body.text for inbound replies (ue_type=2).
  const search = encodeURIComponent(leadEmail);
  const data = await instantlyFetch<{ items: InstantlyEmail[] }>(
    apiKey,
    `/emails?search=${search}&limit=20`
  );
  // Filter to inbound + sort newest first.
  const inbound = (data.items || [])
    .filter((e) => e.ue_type === 2)
    .sort((a, b) => (b.timestamp_email > a.timestamp_email ? 1 : -1));
  const latest = inbound[0];
  if (!latest) return null;
  return latest.body?.text ?? null;
}

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const instantlyKey = process.env.INSTANTLY_API_KEY;
  if (!instantlyKey) {
    return NextResponse.json(
      { error: 'INSTANTLY_API_KEY not configured' },
      { status: 503 }
    );
  }
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json(
      { error: 'RESEND_API_KEY not configured' },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();
  const resend = new Resend(resendKey);
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

  const stats = {
    leads_scanned: 0,
    prospect_matched: 0,
    already_processed: 0,
    classified_positive: 0,
    classified_negative: 0,
    classified_ambiguous: 0,
    scheduled_stage_2: 0,
    marked_unsubscribed: 0,
    forwarded: 0,
    errors: 0,
  };

  // ─── 1. Pull replied leads for each cold campaign ─────────────────
  const repliedLeads: InstantlyLead[] = [];
  for (const campaign of COLD_CAMPAIGN_IDS) {
    try {
      const data = await instantlyFetch<{ items: InstantlyLead[] }>(
        instantlyKey,
        '/leads/list',
        {
          method: 'POST',
          body: JSON.stringify({ campaign, limit: 100 }),
        }
      );
      for (const l of data.items ?? []) {
        if ((l.email_reply_count ?? 0) > 0) repliedLeads.push(l);
      }
    } catch (e) {
      console.error('[instantly-poll] leads list failed:', e);
      stats.errors++;
    }
  }
  stats.leads_scanned = repliedLeads.length;

  // ─── 2. Process each replied lead ────────────────────────────────
  for (const lead of repliedLeads) {
    try {
      const email = lead.email?.toLowerCase().trim();
      if (!email) continue;

      const { data: prospect } = await supabase
        .from('prospects')
        .select(
          'id, cohort, business_name, first_name, email, trade, stage_2_sent_at, unsubscribed_at, audit_upgrade_url'
        )
        .ilike('email', email)
        .eq('cohort', 'cold_email_q2_2026')
        .maybeSingle<{
          id: string;
          cohort: string | null;
          business_name: string;
          first_name: string | null;
          email: string | null;
          trade: string | null;
          stage_2_sent_at: string | null;
          unsubscribed_at: string | null;
          audit_upgrade_url: string | null;
        }>();

      if (!prospect) continue;
      stats.prospect_matched++;

      if (prospect.stage_2_sent_at || prospect.unsubscribed_at) {
        stats.already_processed++;
        continue;
      }

      // Fetch latest inbound body
      const replyText = await fetchLatestInboundBody(instantlyKey, email);
      if (!replyText || replyText.trim().length < 2) {
        // No body to classify yet — leave for next tick. Instantly's
        // ingestion sometimes lags briefly behind their reply count.
        continue;
      }

      const intent = await classifyIntent(replyText);
      if (intent === 'positive') stats.classified_positive++;
      else if (intent === 'negative') stats.classified_negative++;
      else stats.classified_ambiguous++;

      if (intent === 'negative') {
        await supabase
          .from('prospects')
          .update({ unsubscribed_at: new Date().toISOString() })
          .eq('id', prospect.id)
          .is('unsubscribed_at', null);
        stats.marked_unsubscribed++;
        continue;
      }

      if (intent === 'ambiguous') {
        const subject = `[review] ambiguous cold reply — ${prospect.business_name}`;
        const html = `
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
            html,
          });
          stats.forwarded++;
        } catch (e) {
          console.error('[instantly-poll] ambiguous-forward failed', e);
          stats.errors++;
        }
        // Stamp a tombstone so we don't keep forwarding the same
        // ambiguous reply every 2 min. Reuse audit_upgrade_url as
        // the operator-visible marker (it shows up in admin queries).
        await supabase
          .from('prospects')
          .update({
            audit_upgrade_url:
              prospect.audit_upgrade_url ?? `ambiguous:${new Date().toISOString()}`,
            // We don't set stage_2_sent_at — Anthony might still
            // manually approve and trigger Stage 2 via the admin
            // endpoint. To avoid re-forwarding on every tick,
            // ensure the admin-side decision flow stamps stage_2_sent_at
            // OR unsubscribed_at to lock the prospect.
            // Workaround for now: stamp stage_2_sent_at with the
            // marker so the cron stops processing this lead. Anthony's
            // manual admin call falls into the 409 "already_sent"
            // path if he then decides to approve — he can clear the
            // column manually if needed.
            stage_2_sent_at: new Date().toISOString(),
          })
          .eq('id', prospect.id)
          .is('stage_2_sent_at', null);
        continue;
      }

      // intent === 'positive' — schedule Stage 2
      if (!prospect.email || !prospect.first_name) {
        stats.errors++;
        continue;
      }
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
        await supabase
          .from('prospects')
          .update({
            stage_2_sent_at: scheduledAtIso, // treat 'scheduled' as 'sent' for idempotency
            audit_upgrade_url: scanUrl,
          })
          .eq('id', prospect.id)
          .is('stage_2_sent_at', null);
        stats.scheduled_stage_2++;
      } catch (e) {
        console.error('[instantly-poll] schedule failed for', prospect.id, e);
        stats.errors++;
      }
    } catch (e) {
      console.error('[instantly-poll] per-lead loop error:', e);
      stats.errors++;
    }
  }

  return NextResponse.json(stats);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
