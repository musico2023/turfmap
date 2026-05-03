/**
 * POST /api/scans/trigger
 *
 * On-demand scan endpoint. Runs a Live Mode DataForSEO scan against a
 * specific (client, location, keyword) tuple, persists results, fires the
 * post-scan NAP audit, and returns the scan id + computed score family.
 *
 * Body:
 *   { clientId: string, keywordId?: string, locationId?: string }
 *
 *   - clientId: public_id (preferred) or legacy UUID — tolerant lookup.
 *   - locationId: optional; defaults to the client's primary location.
 *     Multi-location clients pass the active location id from the dashboard.
 *   - keywordId: optional; defaults to the location's primary keyword.
 *
 * Response:
 *   200 { scanId, dfsCostCents, totalPoints, failedPoints, found,
 *         turfScore, turfReach, turfRank, momentum }
 *   4xx { error }
 *
 * Notes:
 *   - Synchronous (~15-30s) — the route blocks until the scan completes.
 *   - Actual scan execution lives in lib/scans/runScan.ts so the cron
 *     route shares the same code path. Drift between manual + scheduled
 *     scans is what got us the score-redesign blowback last time.
 */

import { NextResponse } from 'next/server';
import dns from 'node:dns';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { resolveLocation } from '@/lib/supabase/locations';
import { resolveClientUuid } from '@/lib/supabase/client-lookup';
import { runScanForLocation } from '@/lib/scans/runScan';
import { getRescanCapStatus } from '@/lib/scans/rateLimit';
import type { ClientRow, TrackedKeywordRow } from '@/lib/supabase/types';

// Avoid IPv6 ENOTFOUND flakes on dual-stack networks.
dns.setDefaultResultOrder('ipv4first');

export const runtime = 'nodejs';
// Vercel default 300s. DFS scans typically finish in 20-50s but the long
// tail (40207 retries, slow upstream) can push closer to 90s; capping at
// 300s gives us headroom + the NAP audit's BL initiate fan-out (1-2s).
export const maxDuration = 300;

export async function POST(req: Request) {
  // Top-level safety net: any uncaught exception below is converted to a
  // 500 JSON envelope so the ScanButton always sees parseable JSON instead
  // of Vercel's generic HTML error page.
  try {
    return await runScanTrigger(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[/api/scans/trigger] unhandled:', msg, e);
    return NextResponse.json(
      { error: `scan trigger crashed: ${msg}` },
      { status: 500 }
    );
  }
}

async function runScanTrigger(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  let body: { clientId?: string; keywordId?: string; locationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { clientId: clientParam, keywordId, locationId } = body;
  if (!clientParam) {
    return NextResponse.json(
      { error: 'clientId is required' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Tolerant client lookup: ScanButton sends public_id; legacy callers
  // may still send a UUID.
  const clientId = await resolveClientUuid(supabase, clientParam);
  if (!clientId) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Resolve client (need business_name for the matcher) + location +
  // keyword. Multi-location clients pin the scan to one specific
  // storefront — each has its own grid + audit.
  const { data: client } = await supabase
    .from('clients')
    .select('id, business_name')
    .eq('id', clientId)
    .maybeSingle<Pick<ClientRow, 'id' | 'business_name'>>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  const location = await resolveLocation(
    supabase,
    clientId,
    locationId ?? null
  );
  if (!location) {
    return NextResponse.json(
      {
        error:
          'no location found for this client — add at least one location in settings before scanning',
      },
      { status: 400 }
    );
  }

  // Resolve keyword: provided id, else this location's primary, else any
  // for this client (legacy keywords pre-multi-location had no location_id).
  const baseQuery = supabase
    .from('tracked_keywords')
    .select('id, keyword')
    .eq('client_id', clientId);
  let keywordRow: Pick<TrackedKeywordRow, 'id' | 'keyword'> | null = null;
  if (keywordId) {
    const { data } = await baseQuery
      .eq('id', keywordId)
      .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword'>>();
    keywordRow = data ?? null;
  } else {
    const { data: locKw } = await baseQuery
      .eq('location_id', location.id)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword'>>();
    keywordRow = locKw ?? null;
    if (!keywordRow) {
      // Fallback: any keyword on this client (legacy rows w/o location_id).
      const { data: anyKw } = await baseQuery
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle<Pick<TrackedKeywordRow, 'id' | 'keyword'>>();
      keywordRow = anyKw ?? null;
    }
  }
  if (!keywordRow) {
    return NextResponse.json(
      { error: 'no tracked keyword found for this location' },
      { status: 400 }
    );
  }

  // Rate limit: 3 on-demand scans per location per rolling 24h. Live
  // Mode scans cost ~$0.16 each, and same-day rescans don't surface
  // useful score movement (the 12h momentum window already swallows
  // them). The cap protects unit economics while leaving room for the
  // operator to legitimately re-scan after a real GBP/citation change.
  const cap = await getRescanCapStatus(supabase, location.id);
  if (cap.atCap) {
    return NextResponse.json(
      {
        error: `Rate limit: ${cap.limit} on-demand scans per location per 24 hours. Next slot available ${cap.nextAvailableAt ?? 'soon'}.`,
        rateLimit: cap,
      },
      { status: 429 }
    );
  }

  // Delegate to the shared scan executor. Same code path as the cron's
  // scheduled scans — no risk of metric/location-id drift between paths.
  const result = await runScanForLocation(supabase, {
    client,
    location,
    keyword: keywordRow,
    scanType: 'on_demand',
    triggeredBy: auth.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, scanId: result.scanId },
      { status: result.scanId ? 502 : 500 }
    );
  }
  return NextResponse.json(result);
}
