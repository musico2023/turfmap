/**
 * Vercel Cron — Poll Instantly for cold-cohort replies, classify
 * intent with Claude Haiku, and send Stage 2 in-thread via Instantly.
 *
 * Schedule (vercel.json):  every 2 minutes  (cron "* /2 * * * *" — no
 *                          space in actual expression; doc-only escape)
 *
 * Architecture: this cron does TWO passes on each tick.
 *
 * Pass 1 — Classify new replies
 *   1. Pull all cold-campaign leads with email_reply_count > 0 from
 *      Instantly.
 *   2. For each match in prospects (cohort = 'cold_email_q2_2026') that
 *      hasn't been processed (stage_2_scheduled_at + stage_2_sent_at +
 *      unsubscribed_at all NULL), fetch the latest inbound reply body.
 *   3. Classify intent via fast-path regex + Claude Haiku fallback.
 *        positive  → stash reply UUID/eaccount/subject + set
 *                    stage_2_scheduled_at = NOW + 11 min. (Don't send yet.)
 *        negative  → stamp unsubscribed_at. Skip all downstream.
 *        ambiguous → forward to anthony@fourdots.io via Resend. Stamp
 *                    stage_2_sent_at as a tombstone to prevent re-forward.
 *
 * Pass 2 — Send due Stage 2 replies in-thread
 *   1. Query prospects where stage_2_scheduled_at <= NOW and
 *      stage_2_sent_at IS NULL.
 *   2. Render the ColdReplyScanLinkEmail HTML.
 *   3. POST /api/v2/emails/reply with reply_to_uuid + eaccount + body.html
 *      + subject (Re:-prefixed). Instantly threads the reply onto the
 *      same conversation and sends from the same mailbox the cold
 *      message originally came from.
 *   4. Stamp stage_2_sent_at.
 *
 * Why in-thread Instantly (not Resend): preserving thread continuity +
 * the BDR mailbox persona reads natural in the prospect's inbox. The
 * Anthony-as-founder handoff happens at Stage 3, intentionally as a
 * NEW thread from hi@turfmap.ai — that's the relational handoff moment.
 *
 * Cost per tick (typical):
 *   - 1 Instantly leads/list call (free)
 *   - 0-3 Instantly emails/list calls per new reply (free)
 *   - 0-3 Claude Haiku classifications (~$0.0001 each)
 *   - 0-N Instantly emails/reply sends (one per due Stage 2; counts
 *     against Instantly's daily-send mailbox quotas)
 *   - 0-N Resend sends (only for ambiguous-reply operator forwards)
 *
 * Auth: Bearer ${CRON_SECRET}, set automatically by Vercel.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import { getAnthropic } from '@/lib/anthropic/client';
import ColdReplyScanLinkEmail from '@/components/email/ColdReplyScanLinkEmail';

export const runtime = 'nodejs';
export const maxDuration = 60;

const OPERATOR_INBOX = 'anthony@fourdots.io';
const RESEND_FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';

// 11-min delay between positive classification and Stage 2 send.
// Effective wall-clock delay: 11–13 min (cron polls every 2 min).
const STAGE_2_DELAY_MIN = 11;

// Campaign IDs that count as the cold-email cohort.
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

/** Strip any leading "Re:" / "Fwd:" tokens (case-insensitive, repeated)
 *  then prepend a single "Re:". Some inbound replies — especially
 *  auto-replies from Gmail — have multi-prefixed subjects like
 *  "Thanks for Contacting MTAC Plumbing – We'll Respond Soon Re: …".
 *  This helper just guarantees the outgoing subject starts with exactly
 *  one Re: while preserving the rest. */
function reSubject(original: string): string {
  let cleaned = (original ?? '').trim();
  // Drop leading Re:/Fwd:/RE:/FW: repetitions
  cleaned = cleaned.replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '');
  return cleaned ? `Re: ${cleaned}` : 'Re: TurfScan';
}

async function classifyIntent(replyText: string): Promise<Intent> {
  const norm = replyText.toLowerCase().trim().slice(0, 500);
  if (
    /\b(out of office|on vacation|away from|i am away|absence alert|auto[\s-]?reply|on leave|holiday|will be away|return on|i'?ll be back)\b/i.test(
      norm
    )
  ) {
    return 'ambiguous';
  }
  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|send( it)?|please send|i'?ll take it|let'?s do it|go ahead|sounds good)\b/i.test(
      norm
    )
  ) {
    return 'positive';
  }
  if (
    /\b(unsubscribe|remove me|stop|opt[\s-]?out|not interested|no thanks|no thank you|^pass\b|leave me alone)\b/i.test(
      norm
    )
  ) {
    return 'negative';
  }
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
    return 'ambiguous';
  }
}

type InstantlyLead = {
  id: string;
  email: string;
  email_reply_count?: number;
  campaign?: string;
};

type InstantlyEmail = {
  id: string;
  ue_type: number;
  from_address_email: string;
  to_address_email_list: string;
  eaccount?: string;
  subject: string;
  body?: { text?: string; html?: string };
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

/** Fetch the latest inbound (ue_type=2) email for a lead email and
 *  return the full InstantlyEmail object — we need id/eaccount/subject
 *  on the prospect row for the eventual reply send. */
async function fetchLatestInbound(
  apiKey: string,
  leadEmail: string
): Promise<InstantlyEmail | null> {
  const search = encodeURIComponent(leadEmail);
  const data = await instantlyFetch<{ items: InstantlyEmail[] }>(
    apiKey,
    `/emails?search=${search}&limit=20`
  );
  const inbound = (data.items || [])
    .filter((e) => e.ue_type === 2)
    .sort((a, b) => (b.timestamp_email > a.timestamp_email ? 1 : -1));
  return inbound[0] ?? null;
}

type ProspectRow = {
  id: string;
  cohort: string | null;
  business_name: string;
  first_name: string | null;
  email: string | null;
  trade: string | null;
  stage_2_sent_at: string | null;
  stage_2_scheduled_at: string | null;
  unsubscribed_at: string | null;
  audit_upgrade_url: string | null;
  instantly_reply_uuid: string | null;
  instantly_eaccount: string | null;
  instantly_reply_subject: string | null;
};

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

  const supabase = getServerSupabase();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.turfmap.ai';

  const stats = {
    pass1_leads_scanned: 0,
    pass1_prospect_matched: 0,
    pass1_already_processed: 0,
    pass1_classified_positive: 0,
    pass1_classified_negative: 0,
    pass1_classified_ambiguous: 0,
    pass1_scheduled: 0,
    pass1_marked_unsubscribed: 0,
    pass1_forwarded: 0,
    pass2_due_scanned: 0,
    pass2_sent_in_thread: 0,
    errors: 0,
  };

  // ────────────────────────────────────────────────────────────────
  // PASS 1 — Classify new replies, schedule (don't send yet)
  // ────────────────────────────────────────────────────────────────
  const repliedLeads: InstantlyLead[] = [];
  for (const campaign of COLD_CAMPAIGN_IDS) {
    try {
      const data = await instantlyFetch<{ items: InstantlyLead[] }>(
        instantlyKey,
        '/leads/list',
        { method: 'POST', body: JSON.stringify({ campaign, limit: 100 }) }
      );
      for (const l of data.items ?? []) {
        if ((l.email_reply_count ?? 0) > 0) repliedLeads.push(l);
      }
    } catch (e) {
      console.error('[instantly-poll] leads/list failed:', e);
      stats.errors++;
    }
  }
  stats.pass1_leads_scanned = repliedLeads.length;

  for (const lead of repliedLeads) {
    try {
      const email = lead.email?.toLowerCase().trim();
      if (!email) continue;

      const { data: prospect } = await supabase
        .from('prospects')
        .select(
          'id, cohort, business_name, first_name, email, trade, ' +
            'stage_2_sent_at, stage_2_scheduled_at, unsubscribed_at, audit_upgrade_url, ' +
            'instantly_reply_uuid, instantly_eaccount, instantly_reply_subject'
        )
        .ilike('email', email)
        .eq('cohort', 'cold_email_q2_2026')
        .maybeSingle<ProspectRow>();

      if (!prospect) continue;
      stats.pass1_prospect_matched++;

      // Skip if any terminal state already set OR a scheduled send is
      // pending (don't re-schedule the same reply).
      if (
        prospect.stage_2_sent_at ||
        prospect.stage_2_scheduled_at ||
        prospect.unsubscribed_at
      ) {
        stats.pass1_already_processed++;
        continue;
      }

      const inbound = await fetchLatestInbound(instantlyKey, email);
      if (!inbound) continue;
      const replyText = inbound.body?.text ?? '';
      if (replyText.trim().length < 2) continue;

      const intent = await classifyIntent(replyText);
      if (intent === 'positive') stats.pass1_classified_positive++;
      else if (intent === 'negative') stats.pass1_classified_negative++;
      else stats.pass1_classified_ambiguous++;

      if (intent === 'negative') {
        await supabase
          .from('prospects')
          .update({ unsubscribed_at: new Date().toISOString() })
          .eq('id', prospect.id)
          .is('unsubscribed_at', null);
        stats.pass1_marked_unsubscribed++;
        continue;
      }

      if (intent === 'ambiguous') {
        // Forward to operator inbox via Resend (still Resend for ops mail —
        // we only switched the prospect-facing Stage 2 to Instantly).
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          try {
            const resend = new Resend(resendKey);
            await resend.emails.send({
              from: RESEND_FROM_ADDRESS,
              to: OPERATOR_INBOX,
              subject: `[review] ambiguous cold reply — ${prospect.business_name}`,
              html: `
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
              `,
            });
            stats.pass1_forwarded++;
          } catch (e) {
            console.error('[instantly-poll] ambiguous-forward failed', e);
            stats.errors++;
          }
        }
        // Tombstone so we don't re-forward on every tick. Operator's
        // manual admin trigger would 409 on this stamp — they'd need
        // to NULL it first if they decide to proceed. Acceptable tradeoff.
        await supabase
          .from('prospects')
          .update({ stage_2_sent_at: new Date().toISOString() })
          .eq('id', prospect.id)
          .is('stage_2_sent_at', null);
        continue;
      }

      // Positive — stash reply context + schedule the send for NOW + 11min.
      const scheduleAt = new Date(
        Date.now() + STAGE_2_DELAY_MIN * 60 * 1000
      ).toISOString();
      const eaccount = inbound.eaccount ?? inbound.to_address_email_list ?? '';
      if (!eaccount || !inbound.id) {
        console.warn(
          '[instantly-poll] positive reply missing eaccount or id; cannot schedule in-thread send for',
          prospect.id
        );
        stats.errors++;
        continue;
      }
      await supabase
        .from('prospects')
        .update({
          stage_2_scheduled_at: scheduleAt,
          instantly_reply_uuid: inbound.id,
          instantly_eaccount: eaccount,
          instantly_reply_subject: inbound.subject ?? '',
        })
        .eq('id', prospect.id)
        .is('stage_2_scheduled_at', null);
      stats.pass1_scheduled++;
    } catch (e) {
      console.error('[instantly-poll] pass1 per-lead error:', e);
      stats.errors++;
    }
  }

  // ────────────────────────────────────────────────────────────────
  // PASS 2 — Send due Stage 2 replies in-thread
  // ────────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const { data: dueProspects, error: dueErr } = await supabase
    .from('prospects')
    .select(
      'id, cohort, business_name, first_name, email, trade, ' +
        'stage_2_sent_at, stage_2_scheduled_at, unsubscribed_at, audit_upgrade_url, ' +
        'instantly_reply_uuid, instantly_eaccount, instantly_reply_subject'
    )
    .eq('cohort', 'cold_email_q2_2026')
    .is('stage_2_sent_at', null)
    .is('unsubscribed_at', null)
    .lte('stage_2_scheduled_at', nowIso)
    .not('stage_2_scheduled_at', 'is', null)
    .limit(50);

  if (dueErr) {
    console.error('[instantly-poll] pass2 query failed:', dueErr);
    stats.errors++;
  } else if (dueProspects && dueProspects.length > 0) {
    stats.pass2_due_scanned = dueProspects.length;
    for (const p of dueProspects as ProspectRow[]) {
      try {
        if (
          !p.email ||
          !p.first_name ||
          !p.instantly_reply_uuid ||
          !p.instantly_eaccount
        ) {
          console.warn(
            '[instantly-poll] pass2 missing required field for prospect',
            p.id
          );
          stats.errors++;
          continue;
        }
        const scanUrl = buildScanUrl(origin, p.id);
        const html = await render(
          ColdReplyScanLinkEmail({
            firstName: p.first_name,
            businessName: p.business_name,
            trade: p.trade ?? 'service contractor',
            scanUrl,
          })
        );
        const subject = reSubject(p.instantly_reply_subject ?? '');

        // POST /api/v2/emails/reply — Instantly threads + sends in-thread
        // from the original mailbox.
        await instantlyFetch(instantlyKey, '/emails/reply', {
          method: 'POST',
          body: JSON.stringify({
            reply_to_uuid: p.instantly_reply_uuid,
            eaccount: p.instantly_eaccount,
            subject,
            body: { html },
          }),
        });

        // Stamp sent.
        await supabase
          .from('prospects')
          .update({
            stage_2_sent_at: new Date().toISOString(),
            audit_upgrade_url: scanUrl,
          })
          .eq('id', p.id)
          .is('stage_2_sent_at', null);
        stats.pass2_sent_in_thread++;
      } catch (e) {
        console.error('[instantly-poll] pass2 send failed for', p.id, e);
        stats.errors++;
      }
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
