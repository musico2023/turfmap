/**
 * POST /api/funnel/track
 *
 * Client-side ingestor for cold-funnel events fired from the
 * /yourmap lander (scroll milestones, CTA click). Browser sends
 * sendBeacon / fetch with a tiny JSON body; we validate, scanner-bot
 * filter, and insert via the shared logFunnelEvent helper.
 *
 * Auth: open. The endpoint only writes to cold_funnel_events and
 * doesn't read any auth-protected resource. The risk surface is
 * someone spamming bogus events — mitigated by:
 *   (a) closed event_type vocabulary (validated server-side; CHECK
 *       constraint at the DB level too)
 *   (b) scanner-bot UA filter (same one landerVisits uses)
 *   (c) per-IP soft rate limit (described below)
 *   (d) cold_funnel_summary view COUNTs DISTINCT prospect_id per
 *       event_type, so a spammer firing N events for the same
 *       (prospect, event) only counts once
 *
 * Server-side events (free_scan_started, free_scan_completed) are
 * inserted DIRECTLY via lib/analytics/funnelEvents.logFunnelEvent
 * from preview-init / share render and do NOT hit this route — that
 * gives them stricter trust (they're triggered by real backend
 * actions, not arbitrary client posts).
 *
 * Rate limit: 30 events per IP per minute. Legit lander sessions
 * fire ~3 events total (view + scroll_50 + cta_click); 30/min is
 * generous enough to absorb double-fires and dev testing without
 * letting a malicious client flood the table. Backed by a process-
 * local Map (acceptable since Vercel Fluid Compute reuses instances
 * across concurrent requests; per-instance is close enough to
 * per-IP for a soft cap).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  logFunnelEvent,
  type FunnelEventType,
} from '@/lib/analytics/funnelEvents';

export const runtime = 'nodejs';

// Closed event vocabulary — must match the CHECK constraint in
// migration 0041 AND the FunnelEventType union in funnelEvents.ts.
// Mismatches between any two will silently reject events at DB
// insert time; keep them in sync.
const CLIENT_EVENT_TYPES: readonly FunnelEventType[] = [
  'yourmap_view',
  'yourmap_scroll_50',
  'yourmap_scroll_form',
  'coldscan_cta_click',
] as const;

const Body = z.object({
  // Restrict client-fireable events to the lander-side subset.
  // free_scan_started + free_scan_completed are server-only.
  event_type: z.enum(['yourmap_view', 'yourmap_scroll_50', 'yourmap_scroll_form', 'coldscan_cta_click']),
  prospect_id: z.string().min(1).max(64).nullable().optional(),
  utm_source: z.string().max(120).nullable().optional(),
  utm_medium: z.string().max(120).nullable().optional(),
  utm_campaign: z.string().max(200).nullable().optional(),
});

// Per-IP soft rate limit. process-local Map; rolls every minute.
// Vercel Fluid Compute reuses instances across requests so the
// counts persist across short bursts on the same instance, which
// is the regime we care about. For a multi-instance flood, the
// DB CHECK + summary-view DISTINCT-prospect counting are the safety
// net.
const RATE_LIMIT_MAX_PER_MINUTE = 30;
type RateBucket = { count: number; windowStart: number };
const rateBuckets = new Map<string, RateBucket>();
function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const windowSize = 60_000;
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= windowSize) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX_PER_MINUTE) return false;
  bucket.count += 1;
  return true;
}

function clientIp(req: Request): string {
  // Vercel forwards real client IP via x-forwarded-for; take the
  // first hop (the actual client). Fallback to a constant so the
  // rate-limit map doesn't grow unbounded on weird requests.
  const xff = req.headers.get('x-forwarded-for') ?? '';
  return xff.split(',')[0].trim() || 'unknown';
}

export async function POST(req: Request) {
  // Bail on missing/invalid bodies WITHOUT throwing — 400 is fine,
  // we don't want a parse error to mask client-side bugs.
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid body',
      },
      { status: 400 }
    );
  }

  // Soft rate-limit. 429 (not 400) so legitimate browser code can
  // back off rather than reading a bug. Silent-drop is tempting but
  // makes client debugging harder.
  if (!rateLimitOk(clientIp(req))) {
    return NextResponse.json(
      { error: 'rate limit exceeded' },
      { status: 429 }
    );
  }

  // Defensive narrowing: CLIENT_EVENT_TYPES is the source of truth
  // even if the zod enum drifts in a future edit.
  if (!CLIENT_EVENT_TYPES.includes(body.event_type as FunnelEventType)) {
    return NextResponse.json(
      { error: `event_type not allowed from client: ${body.event_type}` },
      { status: 400 }
    );
  }

  // Fire-and-forget log. Response is sent immediately; the insert
  // continues asynchronously. We respond 202 (Accepted) not 200 so
  // the browser knows we didn't synchronously persist — saves
  // sendBeacon callers from waiting for a write confirmation they
  // don't need.
  logFunnelEvent({
    event_type: body.event_type as FunnelEventType,
    prospect_id: body.prospect_id ?? null,
    utm_source: body.utm_source ?? null,
    utm_medium: body.utm_medium ?? null,
    utm_campaign: body.utm_campaign ?? null,
    user_agent: req.headers.get('user-agent'),
    referer: req.headers.get('referer'),
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
