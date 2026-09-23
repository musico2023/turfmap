/**
 * GET /api/prospect/[id]
 *
 * Public endpoint that the /yourmap landing page calls server-side
 * to render personalized hero copy from the prospects table.
 *
 * Behavior:
 *   - 200 + prospect data on success (also stamps view_count++ +
 *     page_viewed_at on first hit)
 *   - 404 if id not found
 *   - 410 if the prospect has already converted_at set — buyer
 *     should be routed to /fourdots instead since their cold-email
 *     personalization is no longer relevant
 *   - 429 if the requesting IP exceeds 100 requests/hour
 *
 * Rate limiting is a soft defense against prospect-id enumeration.
 * In-memory per-instance — works for Vercel Fluid Compute's
 * warm-instance model. A determined attacker who hits multiple
 * regions could bypass; the cost is a leaked prospect record
 * (business_name + city + score), not a security catastrophe.
 *
 * No auth — the endpoint is meant to be hit by the page render
 * itself, which is server-side, but the URL is also discoverable
 * if someone inspects the network tab. Treating it as public.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import type { ProspectRow } from '@/lib/supabase/types';
import { checkRateLimit, clientIpFromRequest } from '@/lib/security/rateLimit';

export const runtime = 'nodejs';

// ─── Rate limit ────────────────────────────────────────────────────────
//
// 100 reqs per IP per rolling hour, for enumeration-prevention (this
// isn't auth). The implementation moved to lib/security/rateLimit so
// /api/places/resolve — which spends Google Places budget per call —
// could share it instead of growing a second copy. Behaviour here is
// unchanged; only the bucket name is new.

const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ─── Handler ──────────────────────────────────────────────────────────

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { error: 'prospect_id_required' },
      { status: 400 }
    );
  }

  // Rate limit FIRST — short-circuits enumeration before we burn
  // a DB roundtrip.
  const ip = clientIpFromRequest(req);
  const rl = checkRateLimit('prospect_detail', ip, {
    max: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limit_exceeded' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
          'X-RateLimit-Remaining': '0',
          'Retry-After': '3600',
        },
      }
    );
  }

  const supabase = getServerSupabase();
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', id)
    .maybeSingle<ProspectRow>();

  if (!prospect) {
    return NextResponse.json(
      { error: 'prospect_not_found' },
      { status: 404 }
    );
  }

  // Already-converted prospects shouldn't see cold-email-style
  // personalization anymore — they bought, they have a dashboard,
  // we route them to /fourdots which has the standard offer.
  if (prospect.converted_at) {
    return NextResponse.json(
      {
        error: 'already_converted',
        redirect_url: '/fourdots',
        converted_at: prospect.converted_at,
      },
      { status: 410 }
    );
  }

  // Stamp view metrics — best-effort. We don't await the result
  // because the response shouldn't block on a write that won't
  // affect the data we're returning. If it errors, log + continue.
  void (async () => {
    try {
      await supabase
        .from('prospects')
        .update({
          view_count: prospect.view_count + 1,
          page_viewed_at: prospect.page_viewed_at ?? new Date().toISOString(),
        })
        .eq('id', id);
    } catch (e) {
      console.error(
        '[prospect] view stamp failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    }
  })();

  return NextResponse.json(
    {
      id: prospect.id,
      business_name: prospect.business_name,
      city: prospect.city,
      trade: prospect.trade,
      preview_score: prospect.preview_score,
      band: getTurfScoreBand(prospect.preview_score).label,
      invisibility_count: prospect.invisibility_count,
      top_competitor_name: prospect.top_competitor_name,
      top_competitor_share_pct: prospect.top_competitor_share_pct,
    },
    {
      headers: {
        'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
        'X-RateLimit-Remaining': String(rl.remaining),
        // Don't cache — the view-stamp side-effect needs to fire on
        // every hit, and the prospect's converted_at can flip
        // mid-session.
        'Cache-Control': 'no-store',
      },
    }
  );
}
