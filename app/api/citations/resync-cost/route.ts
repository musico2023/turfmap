/**
 * POST /api/citations/resync-cost
 *
 * Cost preview for a NAP edit on a Pulse+ client. The settings
 * form calls this before saving high-churn fields so the buyer
 * sees the cost (or "free, X of N remaining this quarter") in a
 * confirmation modal — and the operator can decide to proceed,
 * cancel, or adjust the edit.
 *
 * Read-only — does NOT decrement quota or trigger any BL call.
 * The companion /api/citations/resync endpoint does the actual
 * sync after the operator confirms.
 *
 * Body: { location_id, proposed_profile }
 *
 * The proposed_profile carries only the high-churn fields
 * (business_name + structured NAP). The cost is computed against
 * the current open citation_orders.submitted_profile + the
 * location's free-quota counter.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { estimateResyncCost } from '@/lib/citations/resync';

export const runtime = 'nodejs';

const Body = z.object({
  location_id: z.string().uuid(),
  proposed_profile: z.object({
    business_name: z.string().min(2).max(200),
    street_address: z.string().max(200).nullable(),
    city: z.string().max(120).nullable(),
    region: z.string().max(120).nullable(),
    postcode: z.string().max(20).nullable(),
    country_code: z.string().max(3).nullable(),
    phone: z.string().max(40).nullable(),
  }),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: e.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const estimate = await estimateResyncCost(
    supabase,
    parsed.location_id,
    parsed.proposed_profile
  );

  return NextResponse.json(estimate);
}
