/**
 * POST /api/yourmap/coldscan-fulfill
 *
 * No-Stripe TurfScan fulfillment for the COLDSCAN cold-email cohort —
 * the request-time equivalent of /api/orders/fulfill but with the
 * Stripe + buyer-intake-form steps stripped out. Triggered by the
 * one-click "Run my free TurfScan" button on /yourmap when the
 * visitor arrives with prospect_id + coupon=COLDSCAN and the prospect
 * has geo data backfilled by the lead-gen pipeline.
 *
 * Why this bypass exists: COLDSCAN is a 100%-off promotion code, so
 * Stripe Checkout was buying us nothing on this path except friction
 * (a checkout-flow click-through, plus a webhook + a forced re-entry
 * of business details on /order/success). The lead-gen pipeline
 * already has the prospect's address + geo + business name + trade,
 * so we just create the client + scan directly and hand back a share
 * link.
 *
 * Body:    { prospect_id: string, utm_*: optional }
 * Returns: { share_url, share_id, status: 'created' | 'already_fulfilled' }
 *
 * Abuse + idempotency gates (DFS spend is real on this path — each
 * scan = ~81 DFS Live Mode requests):
 *   - prospect must exist
 *   - prospect.cohort === 'cold_email_q2_2026'
 *   - prospect.unsubscribed_at must be NULL
 *   - prospect must have latitude + longitude + address (geo
 *     backfilled by the lead-gen pipeline; legacy rows without geo
 *     fall back to the Stripe flow on the lander)
 *   - one-free-scan-per-prospect: enforced by the UNIQUE partial index
 *     lead_orders_coldscan_prospect_uidx (migration 0031). Concurrent
 *     POSTs from the same prospect_id resolve to one row; the second
 *     POST detects the existing row and returns the same share link.
 *
 * Long-running: the scan is awaited synchronously (~30-60s typical),
 * matching the fulfill route's pattern. maxDuration=300 gives headroom.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { runScanForLocation } from '@/lib/scans/runScan';
import { generateInsight } from '@/lib/ai-coach/generateInsight';
import { notifyColdscanCompleted } from '@/lib/audit/operatorSlack';
import type {
  ClientLocationRow,
  ClientRow,
  ProspectRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const COLDSCAN_COHORT = 'cold_email_q2_2026';
const SHARE_LINK_DAYS = 90;

const Body = z.object({
  prospect_id: z.string().min(4).max(64),
  utm_source: z.string().max(120).nullish(),
  utm_medium: z.string().max(120).nullish(),
  utm_campaign: z.string().max(200).nullish(),
});

type ExistingShareLookup = { id: string };

export async function POST(req: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError ? e.issues[0].message : 'invalid request body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // ─── 1. Prospect lookup + abuse gates ───────────────────────────────
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', body.prospect_id)
    .maybeSingle<ProspectRow>();
  if (!prospect) {
    return NextResponse.json({ error: 'prospect not found' }, { status: 404 });
  }
  if (prospect.cohort !== COLDSCAN_COHORT) {
    return NextResponse.json(
      {
        error:
          'cohort mismatch — coldscan bypass available only to cold-email prospects',
      },
      { status: 403 }
    );
  }
  if (prospect.unsubscribed_at) {
    return NextResponse.json(
      { error: 'prospect has unsubscribed' },
      { status: 403 }
    );
  }
  if (!prospect.address || prospect.latitude == null || prospect.longitude == null) {
    return NextResponse.json(
      {
        error:
          'prospect missing geo — cannot run scan via coldscan bypass',
      },
      { status: 422 }
    );
  }

  // ─── 2. Idempotency: already-fulfilled → return existing share ───────
  if (prospect.converted_at) {
    const existing = await findExistingShare(supabase, body.prospect_id);
    if (existing) {
      return NextResponse.json({
        status: 'already_fulfilled',
        share_id: existing.id,
        share_url: `/share/${existing.id}`,
      });
    }
    // converted_at set but no share link found — unusual but
    // recoverable. Fall through to recreate everything.
  }

  // ─── 3. Insert client (outreach lead, agency-managed, paused) ────────
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: prospect.business_name.trim(),
      address: prospect.address.trim(),
      latitude: prospect.latitude,
      longitude: prospect.longitude,
      city: prospect.city.trim(),
      country_code: 'USA',
      service_radius_miles: 1.6,
      // Mirror enrich-leads.ts: outreach leads are status='paused' +
      // billing_mode='agency_managed' so they don't pollute the
      // agency listing or recurring crons.
      status: 'paused',
      billing_mode: 'agency_managed',
      is_outreach_lead: true,
    })
    .select('*')
    .single<ClientRow>();
  if (clientErr || !client) {
    return NextResponse.json(
      {
        error: `client insert failed: ${clientErr?.message ?? 'no row returned'}`,
      },
      { status: 500 }
    );
  }

  // Rollback helper for partial-failure paths.
  async function rollback() {
    if (client) {
      await supabase.from('clients').delete().eq('id', client.id);
    }
  }

  // ─── 4. Primary location ─────────────────────────────────────────────
  const { data: location, error: locErr } = await supabase
    .from('client_locations')
    .insert({
      client_id: client.id,
      is_primary: true,
      label: prospect.city.trim(),
      address: prospect.address.trim(),
      city: prospect.city.trim(),
      country_code: 'USA',
      latitude: prospect.latitude,
      longitude: prospect.longitude,
      service_radius_miles: 1.6,
    })
    .select('*')
    .single<ClientLocationRow>();
  if (locErr || !location) {
    await rollback();
    return NextResponse.json(
      { error: `location insert failed: ${locErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  // ─── 5. Tracked keyword (derived from prospect.trade) ────────────────
  const keywordText = prospect.trade.trim();
  const { data: keyword, error: kwErr } = await supabase
    .from('tracked_keywords')
    .insert({
      client_id: client.id,
      location_id: location.id,
      keyword: keywordText,
      // Weekly cadence so the scan exists in the cron's filter universe
      // even though billing_mode='agency_managed' keeps it out of the
      // recurring-scan cron (mirrors enrich-leads convention).
      scan_frequency: 'weekly',
      is_primary: true,
    })
    .select('*')
    .single<TrackedKeywordRow>();
  if (kwErr || !keyword) {
    await rollback();
    return NextResponse.json(
      { error: `keyword insert failed: ${kwErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  // ─── 6. lead_orders row (no Stripe, marked coldscan_free) ────────────
  // Insert this BEFORE running the scan so the UNIQUE partial index on
  // (stripe_metadata->>'prospect_id') WHERE source='coldscan_free'
  // takes the abuse-prevention lock atomically. If a second concurrent
  // POST has already inserted, this insert fails on the constraint and
  // we redirect that caller to the existing share link.
  const stripeMetadata: Record<string, string> = {
    source: 'coldscan_free',
    coupon: 'COLDSCAN',
    prospect_id: prospect.id,
  };
  if (body.utm_source) stripeMetadata.utm_source = body.utm_source;
  if (body.utm_medium) stripeMetadata.utm_medium = body.utm_medium;
  if (body.utm_campaign) stripeMetadata.utm_campaign = body.utm_campaign;

  const { error: orderErr } = await supabase.from('lead_orders').insert({
    stripe_session_id: null,
    tier: 'scan',
    status: 'fulfilled',
    email: prospect.email,
    client_id: client.id,
    stripe_metadata: stripeMetadata,
  });
  if (orderErr) {
    // Most likely the UNIQUE partial index fired — another POST got
    // there first. Roll back our half-created client and return the
    // existing share link (or a 409 if we can't find it).
    await rollback();
    const existing = await findExistingShare(supabase, body.prospect_id);
    if (existing) {
      return NextResponse.json({
        status: 'already_fulfilled',
        share_id: existing.id,
        share_url: `/share/${existing.id}`,
      });
    }
    return NextResponse.json(
      { error: `order insert failed: ${orderErr.message}` },
      { status: 500 }
    );
  }

  // ─── 7. Run the scan synchronously ───────────────────────────────────
  const scanResult = await runScanForLocation(supabase, {
    client,
    location,
    keyword,
    scanType: 'on_demand',
    triggeredBy: null,
  });
  if (!scanResult.ok) {
    // Scan failed but the lead_order + client/location/keyword rows
    // are already written. Don't roll back — let the operator retry
    // the scan from the agency dashboard. Surface the error so the
    // button can show a useful message.
    return NextResponse.json(
      { error: `scan failed: ${scanResult.error}` },
      { status: 502 }
    );
  }

  // ─── 8. Share link (the buyer's destination) ─────────────────────────
  const expiresAt = new Date(
    Date.now() + SHARE_LINK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: share, error: shareErr } = await supabase
    .from('scan_share_links')
    .insert({
      scan_id: scanResult.scanId,
      expires_at: expiresAt,
      // No cta_text / cta_url — the share page detects coldscan_free
      // orders via the parent lead_order and suppresses the entire
      // CTA footer block. The Visibility Audit walkthrough offer
      // lives ONLY in the cold-stage3 follow-up email, never on the
      // share page itself.
    })
    .select('id')
    .single<ExistingShareLookup>();
  if (shareErr || !share) {
    return NextResponse.json(
      {
        error: `share link insert failed: ${shareErr?.message ?? 'no row'}`,
      },
      { status: 500 }
    );
  }

  // ─── 9. Pre-generate the AI Coach Fix List ───────────────────────────
  // The share page (/share/[id]) is the buyer's destination and the
  // only surface they'll ever see for this scan. Unlike the agency
  // console, it has no Generate button — exposing one publicly would
  // let any visitor trigger a paid Claude call. So we pre-generate
  // here, while we still own the request, before redirecting.
  //
  // Tighter NAP-audit wait budget than the operator route (90s vs
  // 240s default) because runScanForLocation above has already burned
  // ~30-60s of the route's 300s maxDuration. Worst-case timing:
  //   scan       (~60s)
  //   NAP poll   (~90s, capped)
  //   Claude     (~60s)
  //   ──────────────────
  //   total      ~210s, well inside 300s.
  //
  // Best-effort: if generation fails (timeout, model refusal, API key
  // missing), we log + still return the share URL. The share page
  // tolerates a missing insight (renders the "81 data points captured"
  // placeholder). Operator can backfill from the agency console's
  // AICoachGenerateButton if needed. Query for orphans:
  //   select c.id, c.business_name, s.id as scan_id
  //   from clients c
  //   join scans s on s.client_id = c.id
  //   join lead_orders lo on lo.client_id = c.id
  //   left join ai_insights ai on ai.scan_id = s.id
  //   where lo.stripe_metadata->>'source' = 'coldscan_free'
  //     and ai.id is null;
  try {
    const insightResult = await generateInsight(
      supabase,
      scanResult.scanId,
      null,
      { napAuditWaitMs: 90_000 }
    );
    if (!insightResult.ok) {
      console.warn(
        '[coldscan-fulfill] AI Coach generation failed for scan',
        scanResult.scanId,
        insightResult.error
      );
    }
  } catch (e) {
    console.warn(
      '[coldscan-fulfill] AI Coach generation threw for scan',
      scanResult.scanId,
      e instanceof Error ? e.message : String(e)
    );
  }

  // ─── 9b. Operator Slack notification (#llm-leads) ────────────────────
  // Fire-and-forget. The free buyer is about to land on /share/<id>;
  // this ping tells the operator a cold-email lead has converted into
  // a scan-viewed state. The cold-stage3 follow-up email (pitching the
  // discounted audit) fires next on the engaged trigger when the
  // buyer opens the share page.
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  try {
    await notifyColdscanCompleted({
      businessName: prospect.business_name.trim(),
      city: prospect.city.trim(),
      trade: prospect.trade.trim(),
      turfScore: scanResult.turfScore,
      shareUrl: `${origin}/share/${share.id}`,
      prospectId: prospect.id,
      utmSource: body.utm_source ?? null,
    });
  } catch (e) {
    console.error(
      '[coldscan-fulfill] notifyColdscanCompleted failed (non-fatal)',
      e instanceof Error ? e.message : String(e)
    );
  }

  // ─── 10. Stamp prospect attribution ──────────────────────────────────
  // converted_at + scan_engaged_at fire at the same moment because the
  // free-scan path has no /order/success intermediate — the buyer
  // clicked through and saw results immediately. scan_engaged_at gates
  // cold-stage3 + ai-coach-nudge per the engaged-route fix shipped
  // earlier this session.
  const nowIso = new Date().toISOString();
  await supabase
    .from('prospects')
    .update({
      converted_at: nowIso,
      scan_engaged_at: nowIso,
    })
    .eq('id', prospect.id)
    .is('converted_at', null);

  return NextResponse.json({
    status: 'created',
    share_id: share.id,
    share_url: `/share/${share.id}`,
  });
}

/**
 * Look up the existing share link for an already-fulfilled prospect.
 * Two-hop lookup: lead_orders by prospect_id → scan_share_links by
 * scan→client. Returns null if anything is missing.
 */
async function findExistingShare(
  supabase: ReturnType<typeof getServerSupabase>,
  prospectId: string
): Promise<ExistingShareLookup | null> {
  const { data: order } = await supabase
    .from('lead_orders')
    .select('client_id')
    .filter('stripe_metadata->>prospect_id', 'eq', prospectId)
    .filter('stripe_metadata->>source', 'eq', 'coldscan_free')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ client_id: string | null }>();
  if (!order?.client_id) return null;

  // Find the latest scan for this client, then its share link.
  const { data: scan } = await supabase
    .from('scans')
    .select('id')
    .eq('client_id', order.client_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!scan) return null;

  const { data: share } = await supabase
    .from('scan_share_links')
    .select('id')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<ExistingShareLookup>();
  return share ?? null;
}
