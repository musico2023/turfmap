/**
 * POST /api/admin/send-cold-stage2
 *
 * Operator endpoint to manually trigger Stage 2 (reply-response scan
 * link delivery) for a cold-email-cohort prospect. Used when:
 *   - The Haiku classifier routed a reply to 'ambiguous' and Anthony
 *     reviews the inbox and decides it IS a positive intent.
 *   - The prospect is from the legacy 'cold_email' cohort (pre-pivot
 *     leads); the polling cron only watches 'cold_email_q2_2026', so
 *     those replies require operator review.
 *   - Anything weird happens with the auto-flow and Anthony wants
 *     to force a send manually.
 *
 * Send path matches the cron's: in-thread via Instantly's
 * POST /api/v2/emails/reply, using the prospect's most recent inbound
 * reply UUID + eaccount. No 11-min delay here — operator triggers run
 * immediately on the assumption that the operator has just decided to
 * send.
 *
 * Auth: bearer token from OPS_ADMIN_SECRET.
 *
 * Request body:
 *   { "prospect_id": "<id>" }
 *
 * Behavior:
 *   1. Look up prospect. Accept BOTH 'cold_email_q2_2026' (new) and
 *      'cold_email' (legacy) cohorts — operator overrides are valid
 *      across either bucket.
 *   2. Verify prospect has email + first_name. Verify stage_2_sent_at
 *      is NULL (don't double-send).
 *   3. Fetch the prospect's latest inbound Instantly reply (need
 *      reply_to_uuid + eaccount + subject for threading).
 *   4. Render the ColdReplyScanLinkEmail HTML.
 *   5. POST /api/v2/emails/reply — send in-thread from the original
 *      cold-email mailbox.
 *   6. Stamp stage_2_sent_at + audit_upgrade_url for operator recovery.
 *
 * Idempotent on stage_2_sent_at IS NULL guard.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { render } from '@react-email/components';
import ColdReplyScanLinkEmail from '@/components/email/ColdReplyScanLinkEmail';

export const runtime = 'nodejs';

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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

function reSubject(original: string): string {
  let cleaned = (original ?? '').trim();
  cleaned = cleaned.replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '');
  return cleaned ? `Re: ${cleaned}` : 'Re: TurfScan';
}

type ProspectRow = {
  id: string;
  cohort: string | null;
  business_name: string;
  first_name: string | null;
  email: string | null;
  trade: string | null;
  stage_2_sent_at: string | null;
  instantly_reply_uuid: string | null;
  instantly_eaccount: string | null;
  instantly_reply_subject: string | null;
};

type InstantlyEmail = {
  id: string;
  ue_type: number;
  eaccount?: string;
  subject: string;
  body?: { text?: string; html?: string };
  timestamp_email: string;
};

async function fetchLatestInbound(
  apiKey: string,
  leadEmail: string
): Promise<InstantlyEmail | null> {
  const search = encodeURIComponent(leadEmail);
  const r = await fetch(`${INSTANTLY_BASE}/emails?search=${search}&limit=20`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': USER_AGENT,
    },
  });
  if (!r.ok) return null;
  const data = (await r.json()) as { items?: InstantlyEmail[] };
  const inbound = (data.items || [])
    .filter((e) => e.ue_type === 2)
    .sort((a, b) => (b.timestamp_email > a.timestamp_email ? 1 : -1));
  return inbound[0] ?? null;
}

export async function POST(req: Request) {
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
      'id, cohort, business_name, first_name, email, trade, ' +
        'stage_2_sent_at, instantly_reply_uuid, instantly_eaccount, instantly_reply_subject'
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
  // Accept either cohort — admin override is valid across both.
  if (
    prospect.cohort !== 'cold_email_q2_2026' &&
    prospect.cohort !== 'cold_email'
  ) {
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
      { error: 'already_sent', stage_2_sent_at: prospect.stage_2_sent_at },
      { status: 409 }
    );
  }

  // Reply context: prefer values the cron already stashed; otherwise
  // fetch the latest inbound from Instantly right now.
  let replyUuid = prospect.instantly_reply_uuid;
  let eaccount = prospect.instantly_eaccount;
  let inboundSubject = prospect.instantly_reply_subject;
  if (!replyUuid || !eaccount) {
    const inbound = await fetchLatestInbound(instantlyKey, prospect.email);
    if (!inbound) {
      return NextResponse.json(
        { error: 'no inbound Instantly reply found for prospect — cannot thread' },
        { status: 400 }
      );
    }
    replyUuid = inbound.id;
    eaccount = inbound.eaccount ?? '';
    inboundSubject = inbound.subject ?? '';
    if (!eaccount) {
      return NextResponse.json(
        { error: 'inbound reply missing eaccount; cannot determine sender mailbox' },
        { status: 400 }
      );
    }
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.turfmap.ai';
  const scanUrl = buildScanUrl(origin, prospect.id);
  const html = await render(
    ColdReplyScanLinkEmail({
      firstName: prospect.first_name,
      businessName: prospect.business_name,
      trade: prospect.trade ?? 'service contractor',
      scanUrl,
    })
  );

  const replyResp = await fetch(`${INSTANTLY_BASE}/emails/reply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${instantlyKey}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      reply_to_uuid: replyUuid,
      eaccount,
      subject: reSubject(inboundSubject ?? ''),
      body: { html },
    }),
  });
  if (!replyResp.ok) {
    return NextResponse.json(
      {
        error: 'instantly_reply_failed',
        http: replyResp.status,
        body: (await replyResp.text()).slice(0, 500),
      },
      { status: 502 }
    );
  }

  const { error: updateErr } = await supabase
    .from('prospects')
    .update({
      stage_2_sent_at: new Date().toISOString(),
      audit_upgrade_url: scanUrl,
    })
    .eq('id', prospect.id)
    .is('stage_2_sent_at', null);
  if (updateErr) {
    console.error('[send-cold-stage2] stamp failed for', prospect.id, updateErr);
    return NextResponse.json(
      { ok: true, warning: 'email sent but stamp failed', stamp_error: updateErr.message },
      { status: 200 }
    );
  }
  return NextResponse.json({
    ok: true,
    prospect_id: prospect.id,
    scan_url: scanUrl,
    sent_from: eaccount,
    threaded_under_reply: replyUuid,
  });
}
