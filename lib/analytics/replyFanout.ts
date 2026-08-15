/**
 * P0.2d fanout — reply classification side-effects.
 *
 * Called from the Instantly reply webhook AFTER the intent is
 * classified and BEFORE downstream Stage-2 scheduling / unsubscribe
 * marking. Purpose:
 *
 *   1. Post a #llm-leads Slack ping with classification + reply
 *      snippet (v2.2 §P0.2 dashboard signal).
 *   2. Log a `reply_received` event to cold_funnel_events so the
 *      §12 dashboard can count replies by classification without
 *      hitting the Instantly API. Single write path per §12.
 *   3. On positive intent, move the prospect's GHL opportunity to
 *      the Hot stage — v2.2 §P0.2 "Move GHL stage to Hot on
 *      interested." Skips silently if GHL creds not configured.
 *
 * Fire-and-forget from the webhook's perspective — errors get logged
 * but never break the reply flow (Instantly retries webhooks that
 * return non-200, and downstream Stage-2 scheduling has its own
 * idempotency).
 */

import { getServerSupabase } from '@/lib/supabase/server';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';

// Constants must match lib/integrations/highlevel.ts.
const COHORT_TAG = 'cold_outbound_q3_2026';
const PIPELINE_NAME = 'Cold Outbound Q3 2026';
const HOT_STAGE_NAME = 'Hot';

export type ReplyIntent = 'positive' | 'negative' | 'ambiguous';

export type ReplyFanoutInput = {
  prospect_id: string;
  business_name: string;
  trade: string | null;
  email: string | null;
  intent: ReplyIntent;
  reply_text_snippet: string;
};

export function fireReplyFanout(input: ReplyFanoutInput): void {
  void runReplyFanout(input).catch((e) => {
    console.warn(
      '[replyFanout] fanout threw for prospect',
      input.prospect_id,
      ':',
      e instanceof Error ? e.message : String(e)
    );
  });
}

async function runReplyFanout(p: ReplyFanoutInput): Promise<void> {
  const supabase = getServerSupabase();

  // 1. Event log — single write path. Uses the same table as scan
  //    fanout so §12 dashboard's reply column reads cleanly.
  try {
    await supabase
      .from('cold_funnel_events')
      .insert({
        // NOTE: 'reply_received' isn't in the existing enum in
        // funnelEvents.ts. If the DB has a CHECK constraint on
        // event_type, this insert will fail — mitigation is to
        // widen the enum in a follow-up migration. Deliberately
        // NOT changing funnelEvents.ts's TypeScript enum here to
        // keep P0.2d additive; the enum will be updated when the
        // event table's constraint (if any) is verified.
        event_type: 'reply_received',
        prospect_id: p.prospect_id,
        // Piggyback classification via a UTM field so we don't have
        // to add a new column just for classification. If we get
        // serious analysis needs, promote to a dedicated column.
        utm_source: 'instantly_reply',
        utm_medium: p.intent,
        utm_campaign: p.trade ?? null,
      });
  } catch (e) {
    console.warn(
      '[replyFanout] event insert failed:',
      e instanceof Error ? e.message : String(e)
    );
  }

  // 2. Slack ping — feed, not dashboard.
  const emoji =
    p.intent === 'positive' ? '✅'
    : p.intent === 'negative' ? '🚫'
    : '❓';
  const label =
    p.intent === 'positive' ? 'interested'
    : p.intent === 'negative' ? 'opted-out'
    : 'ambiguous';
  const text = `${emoji} Reply (${label}) — *${p.business_name}* (${p.trade ?? 'home service'})`;
  const snippet = p.reply_text_snippet.slice(0, 300).replace(/\n+/g, ' ');
  await postOperatorSlack({
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [
        { type: 'mrkdwn', text: `_"${snippet}"_` },
      ]},
      { type: 'context', elements: [
        { type: 'mrkdwn',
          text: `prospect_id: \`${p.prospect_id}\`  ·  from: ${p.email ?? '(unknown)'}` },
      ]},
    ],
  });

  // 3. GHL stage move on positive intent. Only runs when creds are
  //    configured — otherwise silent skip.
  if (p.intent === 'positive' && p.email && process.env.HIGHLEVEL_PIT_TOKEN) {
    try {
      await moveGhlOppToHot({
        email: p.email,
        business_name: p.business_name,
        trade: p.trade,
      });
    } catch (e) {
      console.warn(
        '[replyFanout] GHL move-to-hot failed:',
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

// ─── GHL helpers — thin duplicates of scanViewedFanout's client ────────
// Not importing from lib/integrations/highlevel.ts because that module
// caches pipeline+STAGE for "Scan Viewed"; we want the "Hot" stage. A
// tiny local resolver here keeps the two flows independent. In a later
// pass both should share a common client with a stage-name parameter.

const HIGHLEVEL_API_BASE =
  process.env.HIGHLEVEL_API_BASE ?? 'https://services.leadconnectorhq.com';
const HIGHLEVEL_API_VERSION = process.env.HIGHLEVEL_API_VERSION ?? '2021-07-28';

let cachedHotStage: { pipelineId: string; stageId: string } | null = null;

async function ghlFetch(method: string, path: string, opts: {
  body?: unknown; params?: Record<string, string>;
} = {}): Promise<unknown> {
  const token = process.env.HIGHLEVEL_PIT_TOKEN!;
  const qs = opts.params
    ? '?' + new URLSearchParams(opts.params).toString()
    : '';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Version: HIGHLEVEL_API_VERSION,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${HIGHLEVEL_API_BASE}${path}${qs}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(10_000),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`GHL ${method} ${path} -> ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

async function resolveHotStage(): Promise<{ pipelineId: string; stageId: string }> {
  if (cachedHotStage) return cachedHotStage;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID!;
  const data = (await ghlFetch('GET', '/opportunities/pipelines', {
    params: { locationId },
  })) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };
  const pipeline = data.pipelines?.find(
    (p) => (p.name ?? '').trim().toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!pipeline) throw new Error(`pipeline "${PIPELINE_NAME}" not found`);
  const stage = pipeline.stages?.find(
    (s) => (s.name ?? '').trim().toLowerCase() === HOT_STAGE_NAME.toLowerCase()
  );
  if (!stage) throw new Error(`stage "${HOT_STAGE_NAME}" not found`);
  cachedHotStage = { pipelineId: pipeline.id, stageId: stage.id };
  return cachedHotStage;
}

async function moveGhlOppToHot(args: {
  email: string; business_name: string; trade: string | null;
}): Promise<void> {
  const locationId = process.env.HIGHLEVEL_LOCATION_ID!;
  const { pipelineId, stageId } = await resolveHotStage();

  // Upsert contact (idempotent) so we have a contact_id even if this
  // is a reply from a lead that never opened /yourmap.
  const upsertResp = (await ghlFetch('POST', '/contacts/upsert', {
    body: {
      locationId,
      email: args.email,
      tags: [COHORT_TAG],
      source: 'instantly_reply_hot',
      country: 'CA',
      companyName: args.business_name,
    },
  })) as { contact?: { id?: string }; new_contact?: { id?: string }; id?: string };
  const contactId =
    upsertResp.contact?.id ?? upsertResp.new_contact?.id ?? upsertResp.id;
  if (!contactId) return;

  // Look up existing opportunity for this contact + pipeline. If one
  // exists (Scan Viewed created it earlier), update its stage to Hot.
  // Otherwise create a fresh Hot-stage opportunity.
  const oppSearch = (await ghlFetch(
    'GET',
    '/opportunities/search',
    { params: { location_id: locationId, contact_id: contactId, pipeline_id: pipelineId } }
  )) as { opportunities?: Array<{ id: string }> };
  const existing = oppSearch.opportunities?.[0];

  const name = [args.business_name, args.trade].filter(Boolean).join(' · ') ||
    `Prospect ${contactId}`;

  if (existing) {
    await ghlFetch('PUT', `/opportunities/${existing.id}`, {
      body: {
        pipelineId,
        pipelineStageId: stageId,
        status: 'open',
      },
    });
  } else {
    await ghlFetch('POST', '/opportunities/', {
      body: {
        locationId,
        contactId,
        pipelineId,
        pipelineStageId: stageId,
        name,
        status: 'open',
      },
    });
  }
}
