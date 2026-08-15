/**
 * POST /api/webhooks/postalytics/campaign
 *
 * Fires on send / delivery / bounce / address-correction events from
 * Postalytics (v2.2 §9.3 webhook table). Writes telemetry to
 * cold_funnel_events + updates GHL custom fields where applicable.
 * Deliberately NOT used as a trigger — Canada Post postcard delivery
 * confirmations are sparse; §9 explicitly says treat these as telemetry
 * only, never as workflow triggers.
 *
 * Idempotent — same event can fire twice (Postalytics retries) and the
 * inserts here are safe under natural key (prospect_id + event_type +
 * campaign_id).
 *
 * Auth: shared token with the PURL webhook — POSTALYTICS_WEBHOOK_TOKEN.
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

// Map a Postalytics event name to a canonical event_type we insert
// into cold_funnel_events. Anything unmapped returns null → the
// insert is skipped.
function canonicalize(rawEvent: string): string | null {
  const e = rawEvent.toLowerCase();
  if (/campaign.?sent|piece.?sent/.test(e)) return 'mail_sent';
  if (/delivered/.test(e)) return 'mail_delivered';
  if (/hard.?bounce|undeliverable/.test(e)) return 'mail_bounced';
  if (/address.?correction/.test(e)) return 'mail_address_flag';
  return null;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const rawEvent = String(body.event ?? body.event_type ?? '');
  const canonical = canonicalize(rawEvent);
  if (!canonical) {
    return NextResponse.json({ ok: true, ignored: `event=${rawEvent}` });
  }

  const prospectId = String(
    body.prospect_id ?? body.recipient_reference ?? body.var_field_2 ?? ''
  );
  const campaignId = String(body.campaign_id ?? '');
  if (!prospectId) {
    return NextResponse.json({ ok: true, ignored: 'no prospect_id' });
  }

  const supabase = getServerSupabase();

  // Telemetry write. Same "single write path" rule as scan fanout.
  try {
    await supabase.from('cold_funnel_events').insert({
      event_type: canonical,
      prospect_id: prospectId,
      utm_source: 'postalytics',
      utm_medium: canonical,
      utm_campaign: campaignId || null,
    });
  } catch (e) {
    console.warn('[postalytics-campaign] insert failed:',
      e instanceof Error ? e.message : String(e));
  }

  // Bounce + address-correction get an operator ping (they're
  // actionable). Sent + delivered stay silent — they'd spam #llm-leads
  // at scale (up to 135 sends × 3 whale touches / month).
  if (canonical === 'mail_bounced' || canonical === 'mail_address_flag') {
    const emoji = canonical === 'mail_bounced' ? '📪' : '📍';
    const label = canonical === 'mail_bounced'
      ? 'Undeliverable — suppress from future mail'
      : 'Address correction flagged — review';
    await postOperatorSlack({
      text: `${emoji} ${label} — prospect_id \`${prospectId}\``,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: `${emoji} ${label}` }},
        { type: 'context', elements: [
          { type: 'mrkdwn', text:
            `Postalytics campaign_id: \`${campaignId}\`  ·  prospect_id: \`${prospectId}\``
          },
        ]},
      ],
    });
  }

  return NextResponse.json({ ok: true, event: canonical, prospect_id: prospectId });
}
