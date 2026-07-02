/**
 * P0.2a fanout — Slack ping on `yourmap_view`.
 *
 * When a cold prospect loads /yourmap, logFunnelEvent inserts a
 * yourmap_view row (see funnelEvents.ts) and then calls
 * fireScanViewedFanout() with the prospect_id. Purpose here:
 *
 *   1. Ping #llm-leads via the existing OPERATOR_SLACK_WEBHOOK_URL so
 *      Anthony sees "Business Name (trade, city) just viewed their
 *      scan" as a raised-hand signal in real time (spec v2.2 §P0.2).
 *   2. Dedupe within a 6-hour window — a prospect refreshing or
 *      revisiting the same scan a few times shouldn't spam the feed.
 *      Dedupe key = existing cold_funnel_events rows in the last
 *      6 hours. No new column, no new table.
 *
 * Explicitly NOT here yet (deferred to sibling modules):
 *
 *   - GHL contact upsert / Scan Viewed stage placement (P0.2b)
 *   - SMS trigger (P0.2c) — depends on the GHL workflow existing
 *   - Reply classification (P0.2d, Instantly webhook, unrelated path)
 *
 * Fire-and-forget:
 *   Callers pass in the prospect_id and DO NOT await. The function
 *   returns void — the type signature actively discourages await,
 *   matching logFunnelEvent's pattern. Any Slack / DB error is
 *   swallowed to console.warn — a raised-hand ping isn't worth
 *   breaking a page render for.
 */

import { getServerSupabase } from '@/lib/supabase/server';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';
import { upsertScanViewedToGhl } from '@/lib/integrations/highlevel';

/**
 * Window (in milliseconds) within which a re-view by the same
 * prospect is treated as noise and skipped for fanout. 6 hours =
 * "same session" for a busy operator; long enough to filter
 * refreshes and same-day rechecks, short enough that a next-day
 * revisit is treated as a real fresh signal.
 */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

type ProspectSlice = {
  id: string;
  business_name: string | null;
  trade: string | null;
  city: string | null;
  invisibility_count: number | null;
  top_competitor_name: string | null;
  first_name: string | null;
  email: string | null;
  address: string | null;
  cohort: string | null;
};

/**
 * Public entry point. Void return + no await inside the caller.
 * Called only from logFunnelEvent when event_type === 'yourmap_view'.
 */
export function fireScanViewedFanout(prospectId: string | null): void {
  if (!prospectId) return;
  void runFanout(prospectId).catch((e) => {
    console.warn(
      '[scanViewedFanout] fanout threw for prospect',
      prospectId,
      ':',
      e instanceof Error ? e.message : String(e)
    );
  });
}

async function runFanout(prospectId: string): Promise<void> {
  const supabase = getServerSupabase();

  // Dedupe: any yourmap_view for this prospect within the window
  // that WASN'T the insert we just did means the last-6h ping
  // already fired. The current insert hasn't landed yet on the
  // service-role connection here (race), so we cross-check the
  // count and skip when > 1 rows exist in the window — meaning at
  // least one PRIOR view already exists alongside the fresh insert.
  //
  // Slight over-suppression risk (if two views land within the
  // insert-visibility gap they might both see count=1 and both
  // fire) is acceptable: worst case is 1-2 duplicate Slack pings,
  // and the feed nature of #llm-leads absorbs that. The alternative
  // is a stateful lock, which is overkill for one-line ops pings.
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { count, error: countErr } = await supabase
    .from('cold_funnel_events')
    .select('id', { count: 'exact', head: true })
    .eq('prospect_id', prospectId)
    .eq('event_type', 'yourmap_view')
    .gte('created_at', since);

  if (countErr) {
    console.warn(
      '[scanViewedFanout] dedupe count query failed for prospect',
      prospectId,
      ':',
      countErr.message
    );
    // Fail open: proceed with the ping anyway. Better a duplicate
    // than a silent miss.
  } else if ((count ?? 0) > 1) {
    // Prior view within the window already triggered fanout.
    return;
  }

  // Fetch the prospect slice we need for the ping AND for the GHL
  // upsert. RLS should already permit service-role reads; this hits
  // the same `prospects` table that the /yourmap page reads at render
  // time. Column names verified against lib/supabase/types.ts —
  // invisibility_count (NOT invisible_count), no `state`, no
  // `lost_rev_display` (P0.1 output, not shipped yet).
  const { data: prospect, error: fetchErr } = await supabase
    .from('prospects')
    .select(
      'id,business_name,trade,city,invisibility_count,top_competitor_name,first_name,email,address,cohort'
    )
    .eq('id', prospectId)
    .maybeSingle<ProspectSlice>();

  if (fetchErr) {
    console.warn(
      '[scanViewedFanout] prospect fetch failed for',
      prospectId,
      ':',
      fetchErr.message
    );
    return;
  }
  if (!prospect) {
    console.warn(
      '[scanViewedFanout] no prospect row for id',
      prospectId,
      '- skipping'
    );
    return;
  }

  // Round 1: Slack ping — Anthony sees the raised hand.
  await pingSlack(prospect);

  // Round 2 (P0.2b): GHL upsert into Cold Outbound Q3 2026 → Scan Viewed
  // stage with cohort tag enforced. Fire-and-forget-in-caller but
  // awaited here so a network failure logs + doesn't tank the Slack
  // side. The upsert function itself swallows errors.
  await upsertScanViewedToGhl({
    prospect_id: prospect.id,
    email: prospect.email,
    first_name: prospect.first_name,
    business_name: prospect.business_name,
    trade: prospect.trade,
    city: prospect.city,
    address: prospect.address,
    invisibility_count: prospect.invisibility_count,
    top_competitor_name: prospect.top_competitor_name,
  });
}

async function pingSlack(p: ProspectSlice): Promise<void> {
  const businessName = p.business_name?.trim() || '(unnamed prospect)';
  const trade = p.trade?.trim() || 'home service';
  const location = p.city || 'unknown market';

  // Text is what shows in the channel preview + push notification.
  // Keep it tight — feed, not dashboard.
  const text = `👀 Scan viewed — *${businessName}* (${trade}, ${location})`;

  // Blocks add the pitch context Anthony wants at a glance if he
  // opens the message: invisible cells + top competitor. Dollar hook
  // adds automatically once P0.1 lands lost_rev_display on prospects.
  const contextParts: string[] = [];
  if (p.invisibility_count !== null && p.invisibility_count !== undefined) {
    contextParts.push(`${p.invisibility_count}/81 invisible`);
  }
  if (p.top_competitor_name) {
    contextParts.push(`vs *${p.top_competitor_name}*`);
  }

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];
  if (contextParts.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: contextParts.join('  ·  ') },
      ],
    });
  }
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `prospect_id: \`${p.id}\`` },
    ],
  });

  await postOperatorSlack({ text, blocks });
}
