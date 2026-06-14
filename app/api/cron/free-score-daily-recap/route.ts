/**
 * Vercel Cron — daily 8pm Eastern recap of free-score leads to
 * #llm-leads.
 *
 * Schedule (vercel.json): 0 0 * * * UTC.
 *   - June–Oct (EDT, UTC-4): fires at 8:00 PM Toronto.
 *   - Nov–Mar (EST, UTC-5): fires at 7:00 PM Toronto.
 * Anthony accepts the 1h DST drift over building a DST-aware
 * scheduler. (Vercel Cron is fixed UTC.)
 *
 * What it pushes:
 *   - All free-score leads created in the last 24h (lead_orders
 *     rows where stripe_metadata.lead_source='free_score' AND
 *     stripe_metadata.source='score_preview').
 *   - Per-lead: business name, keyword, TurfScore, market (city),
 *     email, and whether they've unlocked.
 *   - Aggregate: count, avg TurfScore, # unlocked.
 *
 * Channel: same OPERATOR_SLACK_WEBHOOK_URL (#llm-leads) the rest
 * of the operator notifications use. See lib/audit/operatorSlack.ts.
 *
 * Silent on zero: when no leads in the last 24h, posts a single-
 * line "No new free-score leads in the last 24h" so Anthony knows
 * the cron actually fired (vs. a silent failure). Toggle SUPPRESS_
 * ZERO_RECAP=1 to suppress the zero-day ping if it becomes noise.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} — Vercel Cron sets
 * this automatically. Manual invocation requires the same header.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';

export const runtime = 'nodejs';
export const maxDuration = 30;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

type LeadRow = {
  created_at: string;
  email: string | null;
  business_name: string | null;
  address: string | null;
  keyword: string | null;
  turf_score: number | string | null;
  turf_reach: number | null;
  share_id: string | null;
  unlocked: boolean;
};

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // SQL is identical in shape to the ad-hoc export Anthony pulled.
  // Postgres lets us aggregate scans + share-link lookups in the
  // same query so the cron only round-trips once.
  const { data, error } = await supabase.rpc('free_score_leads_since', {
    since: windowStart,
  });

  // RPC fallback: if the RPC doesn't exist (first deploy before
  // the migration adds the function), do the lookup inline. Pure
  // table reads, no joins to a missing fn.
  let leads: LeadRow[] | null = null;
  if (error?.code === 'PGRST202' || error?.code === '42883' || !data) {
    leads = await loadLeadsInline(supabase, windowStart);
  } else {
    leads = data as LeadRow[];
  }

  if (!leads) leads = [];

  if (leads.length === 0) {
    if (process.env.SUPPRESS_ZERO_RECAP !== '1') {
      await postOperatorSlack({
        text: '🟢 Free-score recap: no new leads in the last 24h.',
      });
    }
    return NextResponse.json({ ok: true, leadCount: 0 });
  }

  // Aggregate roll-up
  const scores = leads
    .map((l) => Number(l.turf_score))
    .filter((n) => Number.isFinite(n));
  const avgScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;
  const unlockedCount = leads.filter((l) => l.unlocked).length;

  // Compose the message. text= is the channel preview / push-
  // notification body; blocks= renders the rich detail.
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Toronto',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const headline = `📋 Free-score recap · ${dateLabel} · ${leads.length} new lead${
    leads.length === 1 ? '' : 's'
  }`;

  const summary =
    `• ${leads.length} new lead${leads.length === 1 ? '' : 's'}` +
    (avgScore !== null ? `  · avg TurfScore ${avgScore}` : '') +
    (unlockedCount > 0
      ? `  · ${unlockedCount} unlocked ($49)`
      : '  · 0 unlocked yet');

  // Per-lead bullets. Keep tight — Slack truncates long blocks.
  // Slack block "text" cap is 3000 chars; each line is ~120 chars,
  // so 25 leads fit. We cap at 25 + an overflow line for safety.
  const MAX_LINES = 25;
  const visible = leads.slice(0, MAX_LINES);
  const overflowCount = Math.max(0, leads.length - MAX_LINES);

  const lines = visible.map((l) => {
    const city = cityFromAddress(l.address);
    const score =
      l.turf_score !== null && l.turf_score !== undefined
        ? `${l.turf_score}`
        : '—';
    const biz = l.business_name?.trim() || '(no business name)';
    const kw = l.keyword?.trim() ? `"${l.keyword.trim()}"` : '—';
    const email = l.email?.trim() || '—';
    const cityFrag = city ? ` · ${city}` : '';
    const unlockTag = l.unlocked ? ' · 🟩 unlocked' : '';
    const time = new Date(l.created_at).toLocaleTimeString('en-US', {
      timeZone: 'America/Toronto',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `• *${biz}*${cityFrag} · ${kw} · score *${score}*${unlockTag}\n   ${email} · ${time} ET`;
  });

  if (overflowCount > 0) {
    lines.push(`_+ ${overflowCount} more not shown_`);
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headline, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summary },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: lines.join('\n'),
      },
    },
  ];

  const ok = await postOperatorSlack({
    text: `${headline} · ${summary}`,
    blocks,
  });

  return NextResponse.json({
    ok,
    leadCount: leads.length,
    avgScore,
    unlockedCount,
  });
}

/** Pull leads inline when the helper RPC isn't available. Mirrors
 *  the ad-hoc SQL query against lead_orders → clients →
 *  tracked_keywords → scans → scan_share_links. */
async function loadLeadsInline(
  supabase: ReturnType<typeof getServerSupabase>,
  since: string
): Promise<LeadRow[]> {
  // Two-step approach: pull the lead_orders rows first, then fan
  // out per-client lookups for the joined fields. Two round trips
  // total, which is fine — the daily lead volume is small.
  const { data: orders } = await supabase
    .from('lead_orders')
    .select('created_at, email, client_id, stripe_metadata')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .returns<
      Array<{
        created_at: string;
        email: string | null;
        client_id: string | null;
        stripe_metadata: Record<string, unknown> | null;
      }>
    >();

  const freeScoreOrders = (orders ?? []).filter((o) => {
    const m = o.stripe_metadata ?? {};
    return (
      (m as Record<string, unknown>)['lead_source'] === 'free_score' &&
      (m as Record<string, unknown>)['source'] === 'score_preview'
    );
  });

  if (freeScoreOrders.length === 0) return [];

  const clientIds = Array.from(
    new Set(
      freeScoreOrders
        .map((o) => o.client_id)
        .filter((id): id is string => typeof id === 'string')
    )
  );

  const [{ data: clients }, { data: keywords }, { data: scans }] =
    await Promise.all([
      supabase
        .from('clients')
        .select('id, business_name, address')
        .in('id', clientIds)
        .returns<
          Array<{
            id: string;
            business_name: string;
            address: string | null;
          }>
        >(),
      supabase
        .from('tracked_keywords')
        .select('id, client_id, keyword')
        .in('client_id', clientIds)
        .returns<
          Array<{ id: string; client_id: string; keyword: string }>
        >(),
      supabase
        .from('scans')
        .select('client_id, keyword_id, turf_score, turf_reach, created_at')
        .in('client_id', clientIds)
        .returns<
          Array<{
            client_id: string;
            keyword_id: string;
            turf_score: number | string | null;
            turf_reach: number | null;
            created_at: string;
          }>
        >(),
    ]);

  // Build per-client lookups
  const clientById = new Map(
    (clients ?? []).map((c) => [c.id, c] as const)
  );
  const keywordByClient = new Map<string, { id: string; keyword: string }>();
  for (const k of keywords ?? []) {
    if (!keywordByClient.has(k.client_id)) {
      keywordByClient.set(k.client_id, { id: k.id, keyword: k.keyword });
    }
  }
  // Most-recent scan per (client, keyword)
  const scanByPair = new Map<
    string,
    { turf_score: number | string | null; turf_reach: number | null }
  >();
  for (const s of (scans ?? []).sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  )) {
    const key = `${s.client_id}:${s.keyword_id}`;
    if (!scanByPair.has(key)) {
      scanByPair.set(key, {
        turf_score: s.turf_score,
        turf_reach: s.turf_reach,
      });
    }
  }

  // Unlock detection: a fulfilled lead_orders row with
  // stripe_metadata.source='score_unlock' for the same client.
  const { data: unlockOrders } = await supabase
    .from('lead_orders')
    .select('client_id, stripe_metadata, status')
    .in('client_id', clientIds)
    .returns<
      Array<{
        client_id: string;
        stripe_metadata: Record<string, unknown> | null;
        status: string;
      }>
    >();
  const unlockedClientIds = new Set(
    (unlockOrders ?? [])
      .filter(
        (o) =>
          o.status === 'fulfilled' &&
          (o.stripe_metadata as Record<string, unknown> | null)?.['source'] ===
            'score_unlock'
      )
      .map((o) => o.client_id)
  );

  return freeScoreOrders.map((o) => {
    const c = o.client_id ? clientById.get(o.client_id) : undefined;
    const kw = o.client_id ? keywordByClient.get(o.client_id) : undefined;
    const scan =
      o.client_id && kw
        ? scanByPair.get(`${o.client_id}:${kw.id}`)
        : undefined;
    return {
      created_at: o.created_at,
      email: o.email,
      business_name: c?.business_name ?? null,
      address: c?.address ?? null,
      keyword: kw?.keyword ?? null,
      turf_score: scan?.turf_score ?? null,
      turf_reach: scan?.turf_reach ?? null,
      share_id: null,
      unlocked: o.client_id ? unlockedClientIds.has(o.client_id) : false,
    };
  });
}

/** Pull a "City, Region" fragment out of a comma-separated address
 *  string. Stops at the first 2-letter postal/state token so we
 *  don't drag the country into the Slack line. Best-effort. */
function cityFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim());
  if (parts.length === 0) return null;
  // Drop the street-address head; keep the next 1-2 parts that
  // look like city + region.
  const tail = parts.slice(1);
  if (tail.length === 0) return parts[0];
  const cityCandidate = tail[0];
  const regionCandidate = tail[1];
  if (
    regionCandidate &&
    /^[A-Z]{2,}( [A-Z0-9]+)?$/.test(regionCandidate.split(' ')[0] ?? '')
  ) {
    return `${cityCandidate}, ${regionCandidate.split(' ')[0]}`;
  }
  return cityCandidate;
}
