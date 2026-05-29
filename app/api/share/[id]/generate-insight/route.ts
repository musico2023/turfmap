/**
 * POST /api/share/[id]/generate-insight
 *
 * Public AI Coach generation triggered from the /share/<id> page.
 * The share page is the cold-outreach buyer's only surface — they
 * have no Supabase auth, so they can't hit /api/ai/insights (which
 * is gated by requireAgencyUserForApi). This route is the
 * share-id-gated equivalent.
 *
 * Auth: presenting a valid, non-revoked, non-expired share_id IS
 * the credential. The share_id is a UUID — unguessable without the
 * share link itself, which we only hand out to:
 *   - cold buyers via the COLDSCAN-fulfill redirect
 *   - paid scan buyers via the sendScanReady email (legacy share
 *     URLs from before the portal swap)
 *   - operators sharing manually with prospects
 *
 * Abuse profile:
 *   - One generation per scan: ai_insights existence is checked first
 *     and an existing row short-circuits the Claude call. So even if
 *     an attacker knew the share_id, they could only trigger ONE
 *     paid Claude call per scan_id, ever. After that, all repeated
 *     POSTs return the cached row.
 *   - No financial exposure beyond one Claude call (~$0.05).
 *
 * Body:    none (scan_id is derived from the share row)
 * Returns: { ok: true } on success — the share page is a server
 *          component so the frontend triggers a hard refresh after
 *          getting 200 and reads the freshly-stamped ai_insights row.
 *
 * Why we removed the inline COLDSCAN pre-generation:
 *   Pre-generation forced the cold buyer to wait 60-150s on the
 *   /yourmap overlay before landing on /share. Adding the
 *   auto-generation to paid /api/orders/fulfill pushed paid waits
 *   into the same range. Moving generation to "user clicks button
 *   when ready" cuts the redirect latency to 30-90s (scan only)
 *   and lets the buyer see their heatmap immediately. AI Coach
 *   is a second-click action they can take when they're ready.
 *
 * Cost ceiling: ~$0.05 per call (Claude Sonnet, 16k max_tokens).
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { generateInsight } from '@/lib/ai-coach/generateInsight';

export const runtime = 'nodejs';
// Matches the agency-side /api/ai/insights ceiling. Claude + NAP
// poll typically resolves in 30-90s; 300s gives comfortable
// headroom for tail latencies + a Fluid Compute cold start.
export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: shareId } = await params;
  if (!shareId || typeof shareId !== 'string') {
    return NextResponse.json(
      { error: 'invalid share id' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // 1. Resolve the share link and validate it's still active.
  //    We allow generation even on expired/revoked shares for the
  //    operator (who'd just regenerate the share), but to keep the
  //    surface tight we just reject — anyone hitting an expired
  //    share has bigger UX problems than a missing Fix List.
  const { data: share } = await supabase
    .from('scan_share_links')
    .select('id, scan_id, expires_at, revoked_at')
    .eq('id', shareId)
    .maybeSingle<{
      id: string;
      scan_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>();
  if (!share) {
    return NextResponse.json({ error: 'share not found' }, { status: 404 });
  }
  if (share.revoked_at) {
    return NextResponse.json({ error: 'share revoked' }, { status: 410 });
  }
  if (new Date(share.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'share expired' }, { status: 410 });
  }

  // 2. Generate (or return existing). generateInsight is idempotent
  //    on scan_id — a pre-existing ai_insights row short-circuits
  //    the Claude call. Passes null for user_id since this isn't
  //    an authenticated agency-staff trigger.
  const result = await generateInsight(supabase, share.scan_id, null);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    scanId: result.scanId,
    // Echo a minimal subset for clients that want to skip the hard
    // refresh and just inline the result. The share page does a
    // router.refresh() so it re-reads the row from Supabase, but
    // shape parity here is cheap.
    diagnosis: result.diagnosis,
    actionsCount: result.actions?.length ?? 0,
  });
}
