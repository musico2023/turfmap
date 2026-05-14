/**
 * POST /api/clients/[id]/tier
 *
 * Agency-side tier override. Lets the operator manually set a
 * client's recurring tier without touching Stripe — useful for
 * demo accounts, agency-managed contracts, or recovery scenarios
 * where the Stripe webhook hasn't fired yet.
 *
 * Body: { tier: 'pulse' | 'pulse_plus' | null }
 *
 * NULL clears the override; the column is then "unset" until the
 * webhook (or another manual override) writes it again. one_time
 * clients can have a tier set but the resolver will ignore it
 * (their billing_mode wins).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

const Body = z.object({
  tier: z.enum(['pulse', 'pulse_plus']).nullable(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('clients')
    .update({ tier: parsed.tier })
    .eq('id', client.id);
  if (error) {
    return NextResponse.json(
      { error: `tier update failed: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, tier: parsed.tier });
}
