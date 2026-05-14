/**
 * Vercel Cron — weekly GBP-signals refresh.
 *
 * Schedule (vercel.json): Mondays at 14:00 UTC, paired with the
 * weekly-competitor-summary so the AI Coach playbooks generated
 * mid-week have fresh signals to cite. Cost ~$0.020 per location
 * per refresh (Place Details Pro tier). Skips locations without a
 * stored google_place_id.
 *
 * Scoped to:
 *   - clients.status != 'churned' (departed clients aren't worth
 *     the API call)
 *   - client_locations.google_place_id is not null (no point
 *     fetching for unmatched locations)
 *
 * Bounded concurrency: 5 in-flight calls. Plenty for the next year
 * of growth and well under Google's quota.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Soft-fails to a 200
 * with `skipped: 'no_api_key'` when GOOGLE_PLACES_API_KEY is unset
 * (e.g. preview deployments) so cron uptime telemetry stays clean.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { refreshLocationSignals } from '@/lib/google/enrich';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 5;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return NextResponse.json({ checked: 0, refreshed: 0, skipped: 'no_api_key' });
  }

  const supabase = getServerSupabase();

  // Pull all eligible (location, place_id) pairs. Joining clients lets
  // us filter out churned customers without an extra round-trip.
  const { data: rows, error } = await supabase
    .from('client_locations')
    .select('id, google_place_id, clients!inner(status)')
    .not('google_place_id', 'is', null)
    .neq('clients.status', 'churned')
    .returns<{ id: string; google_place_id: string }[]>();
  if (error) {
    return NextResponse.json(
      { error: `query failed: ${error.message}` },
      { status: 500 }
    );
  }
  const eligible = rows ?? [];
  if (eligible.length === 0) {
    return NextResponse.json({ checked: 0, refreshed: 0 });
  }

  let refreshed = 0;
  let totalCostCents = 0;

  // Bounded-concurrency worker pool.
  const queue = [...eligible];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      try {
        const cost = await refreshLocationSignals(supabase, {
          locationId: item.id,
          placeId: item.google_place_id,
        });
        if (cost !== null) {
          refreshed += 1;
          totalCostCents += cost;
        }
      } catch (e) {
        console.warn('[refresh-gbp-signals] worker error', e);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, () =>
      worker()
    )
  );

  return NextResponse.json({
    checked: eligible.length,
    refreshed,
    cost_cents: totalCostCents,
  });
}
