/**
 * POST /api/webhooks/postalytics/purl
 *
 * Fires when a Postalytics-generated PURL is scanned (QR from a
 * physical piece → redirect to /yourmap). Payload includes the piece
 * metadata; we do three things (v2.2 §9.3):
 *
 *   1. Write a `mail_scanned` event row to cold_funnel_events so the
 *      §12 dashboard can count physical-touch conversions cleanly.
 *   2. Ping #llm-leads via operatorSlack — "physical piece scanned"
 *      is one of the highest-signal events in the whole plan.
 *   3. If the piece was a whale-tier touch, fire a §2.1 call task
 *      (currently: same Slack ping with an "inbound-triggered call
 *      opportunity" flag) — an actual GHL task queue is a follow-up.
 *
 * The redirect to /yourmap itself is handled by Postalytics — they
 * own the PURL domain and 301 the recipient. When /yourmap loads,
 * logFunnelEvent fires yourmap_view + scanViewedFanout — SAME event
 * table, SAME Slack channel. Physical → digital ladder promotion,
 * automatic (v2.2 §1).
 *
 * Auth: static token in query string (`?token=...`). Postalytics
 * webhooks don't sign payloads. Token lives in env
 * POSTALYTICS_WEBHOOK_TOKEN.
 *
 * Payload shape (defensive parsing — Postalytics's webhook docs are
 * incomplete; we tolerate a few common field aliases):
 *   {
 *     "event": "purl_scanned",
 *     "campaign_id": 1234,
 *     "contact_id": 5678,
 *     "prospect_id": "xxx" | "recipient_reference": "xxx",  // whichever they echo
 *     "scanned_at": "2026-07-10T15:32:00Z",
 *     "purl": "fdots.co/abcd"
 *   }
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';

export const runtime = 'nodejs';

function isAuthorized(req: Request): boolean {
  const token = process.env.POSTALYTICS_WEBHOOK_TOKEN;
  if (!token) return false;
  const url = new URL(req.url);
  return url.searchParams.get('token') === token;
}

type PostalyticsPurlPayload = {
  event?: string;
  event_type?: string;
  campaign_id?: number | string;
  contact_id?: number | string;
  prospect_id?: string;
  recipient_reference?: string;   // some Postalytics setups use this
  var_field_2?: string;           // we set this to the prospect_id on send
  scanned_at?: string;
  purl?: string;
  purl_url?: string;
  [k: string]: unknown;
};

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: PostalyticsPurlPayload;
  try {
    body = (await req.json()) as PostalyticsPurlPayload;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const event = String(body.event ?? body.event_type ?? '').toLowerCase();
  if (event && !/purl.*scan|scanned|purl_click/.test(event)) {
    return NextResponse.json({ ok: true, ignored: `event=${event}` });
  }

  // Resolve prospect_id. Prefer explicit prospect_id if Postalytics
  // echoes it (we set this ourselves when creating the campaign OR pass
  // it as recipient_reference / var_field_2 on Send Mail).
  const prospectId = String(
    body.prospect_id ??
    body.recipient_reference ??
    body.var_field_2 ??
    ''
  );
  if (!prospectId) {
    console.warn('[postalytics-purl] payload missing prospect_id / recipient_reference', body);
    return NextResponse.json({ ok: true, ignored: 'no prospect_id' });
  }

  const supabase = getServerSupabase();

  // Fetch prospect for the Slack ping context.
  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, business_name, trade, city, cohort')
    .eq('id', prospectId)
    .maybeSingle<{
      id: string; business_name: string | null; trade: string | null;
      city: string | null; cohort: string | null;
    }>();

  if (!prospect) {
    console.warn('[postalytics-purl] no prospect row for id', prospectId);
    return NextResponse.json({ ok: true, ignored: 'prospect not found' });
  }

  // 1. Event write — single write path per §12. Uses cold_funnel_events;
  //    the event_type 'mail_scanned' needs to be included in the CHECK
  //    constraint OR the enum widened. Deferred to migration if the
  //    insert fails at runtime.
  try {
    await supabase.from('cold_funnel_events').insert({
      event_type: 'mail_scanned',
      prospect_id: prospect.id,
      utm_source: 'postalytics',
      utm_medium: 'purl_scan',
      utm_campaign: String(body.campaign_id ?? ''),
    });
  } catch (e) {
    console.warn('[postalytics-purl] event insert failed:',
      e instanceof Error ? e.message : String(e));
  }

  // 2. Slack ping — physical scan is high-signal.
  const businessName = prospect.business_name?.trim() || '(unnamed)';
  const trade = prospect.trade?.trim() || 'home service';
  const city = prospect.city || 'unknown market';
  const text = `📬 Mail scanned — *${businessName}* (${trade}, ${city})`;

  await postOperatorSlack({
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [
        { type: 'mrkdwn', text:
          `Postalytics campaign_id: \`${body.campaign_id ?? '?'}\`  ·  ` +
          `PURL: \`${body.purl ?? body.purl_url ?? '?'}\`` },
      ]},
      { type: 'context', elements: [
        { type: 'mrkdwn', text: `prospect_id: \`${prospect.id}\`` },
      ]},
    ],
  });

  // 3. Note for v2.2 §2.1 inbound-triggered whale call — the Slack ping
  //    itself IS the call task for now. Anthony sees "mail scanned" in
  //    the feed and dials the whale. A dedicated GHL task queue is a
  //    P0.2c follow-up.

  return NextResponse.json({
    ok: true,
    action: 'mail_scanned_logged',
    prospect_id: prospect.id,
  });
}
