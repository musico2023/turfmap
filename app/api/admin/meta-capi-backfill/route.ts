/**
 * POST /api/admin/meta-capi-backfill
 *
 * One-shot admin endpoint for sending a backdated Meta CAPI Purchase
 * event for a score_unlock conversion that fulfilled BEFORE we
 * shipped the server-side CAPI wiring. Pre-fix conversions never
 * fired a Purchase, so Meta Events Manager is missing them — this
 * endpoint patches a specific one by stripe_session_id.
 *
 * Meta accepts event_time up to ~7 days in the past for attribution
 * purposes. Use within that window; older conversions still POST
 * but won't be matched to ad-set attribution by Meta's model.
 *
 * Auth: CRON_SECRET bearer token OR agency-owner Supabase session
 * (same dual-path as other /api/admin routes).
 *
 * Body:
 *   { stripe_session_id: 'cs_live_...' }
 *
 * Response:
 *   200 { ok: true, event_id, value, currency, capi_result }
 *   404 lead_orders row not found for that session
 *   409 already has meta_purchase_event_id stamped (no-op)
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getServerSupabase } from '@/lib/supabase/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';
import {
  sendMetaCapiEvent,
  buildFbcFromFbclid,
} from '@/lib/marketing/metaCapi';

export const runtime = 'nodejs';

const Body = z.object({
  stripe_session_id: z.string().min(4),
  /** When true, fire the CAPI event even if meta_purchase_event_id
   *  is already stamped on the row. Default false (idempotent) so
   *  accidental re-runs don't double-fire. */
  force: z.boolean().optional(),
});

async function isAuthorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get('authorization') ?? '';
    if (header === `Bearer ${secret}`) return true;
  }
  try {
    const auth = await getAuthSupabase();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (isAgencyOwnerEmail(user?.email ?? null)) return true;
  } catch {
    // Fall through.
  }
  return false;
}

export async function POST(req: Request) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join(', ')
            : 'invalid body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Pull the score_unlock lead_orders row + the original preview row
  // (for attribution_fbclid / lead_source).
  const { data: unlockRow } = await supabase
    .from('lead_orders')
    .select('id, email, client_id, created_at, stripe_metadata')
    .eq('stripe_session_id', body.stripe_session_id)
    .maybeSingle<{
      id: string;
      email: string | null;
      client_id: string | null;
      created_at: string;
      stripe_metadata: Record<string, unknown> | null;
    }>();
  if (!unlockRow) {
    return NextResponse.json(
      { error: 'lead_orders row not found for that stripe_session_id' },
      { status: 404 }
    );
  }
  if (
    !body.force &&
    typeof unlockRow.stripe_metadata?.meta_purchase_event_id === 'string'
  ) {
    return NextResponse.json(
      {
        error: 'meta_purchase_event_id already stamped — pass force:true to override',
        existing_event_id: unlockRow.stripe_metadata.meta_purchase_event_id,
      },
      { status: 409 }
    );
  }

  // Fish out attribution from the original /prove-it preview row.
  let leadSource: string | null = null;
  let fbclid: string | null = null;
  let phone: string | null = null;
  if (unlockRow.client_id) {
    const { data: previewRow } = await supabase
      .from('lead_orders')
      .select('stripe_metadata')
      .eq('client_id', unlockRow.client_id)
      .order('created_at', { ascending: true })
      .limit(10)
      .returns<Array<{ stripe_metadata: Record<string, unknown> | null }>>();
    const preview = (previewRow ?? []).find(
      (r) => r.stripe_metadata?.source === 'score_preview'
    );
    const meta = preview?.stripe_metadata ?? null;
    if (meta) {
      if (typeof meta.lead_source === 'string') leadSource = meta.lead_source;
      if (typeof meta.attribution_fbclid === 'string')
        fbclid = meta.attribution_fbclid;
      if (typeof meta.phone === 'string') phone = meta.phone;
    }
  }

  const fbc = fbclid
    ? buildFbcFromFbclid(
        fbclid,
        // Use the original conversion's timestamp as the fbc
        // creation time so the cookie value is consistent with
        // when the click actually happened.
        new Date(unlockRow.created_at).getTime()
      )
    : null;

  // Amount: try metadata first, fall back to 4900 ($49 MAPCHECK50
  // discount price which is what score_unlock buyers actually paid).
  let valueCents = 4900;
  if (
    typeof unlockRow.stripe_metadata?.meta_purchase_value_cents === 'string'
  ) {
    const parsed = Number(unlockRow.stripe_metadata.meta_purchase_value_cents);
    if (Number.isFinite(parsed) && parsed > 0) valueCents = parsed;
  }

  const eventId = randomUUID();
  const customData: Record<string, string | number | boolean> = {
    content_name: 'TurfScan',
    content_category: 'score_unlock',
    value: valueCents / 100,
    currency: 'USD',
  };
  if (leadSource) customData.lead_source = leadSource;

  const result = await sendMetaCapiEvent({
    event: 'Purchase',
    eventId,
    // event_time backdated to when the conversion actually happened.
    // Meta accepts up to ~7 days in the past for attribution.
    eventTimeSeconds: Math.floor(
      new Date(unlockRow.created_at).getTime() / 1000
    ),
    userData: {
      email: unlockRow.email ?? undefined,
      phone,
      fbc,
    },
    customData,
  });

  // Stamp the event_id back on the row regardless of CAPI success —
  // if it succeeded, this records what we sent; if it failed, it
  // records that an attempt was made so we don't accidentally
  // double-fire on a retry. Use a distinct flag to track failed
  // attempts.
  const metaPatch: Record<string, string> = {
    meta_purchase_event_id: eventId,
    meta_purchase_value_cents: String(valueCents),
    meta_purchase_capi_fired: result.ok ? 'true' : 'false',
    meta_purchase_backfilled: 'true',
    meta_purchase_backfilled_at: new Date().toISOString(),
  };
  if (!result.ok) {
    metaPatch.meta_purchase_capi_failure_reason = result.reason;
  }

  await supabase
    .from('lead_orders')
    .update({
      stripe_metadata: {
        ...(unlockRow.stripe_metadata ?? {}),
        ...metaPatch,
      },
    })
    .eq('id', unlockRow.id);

  return NextResponse.json({
    ok: result.ok,
    event_id: eventId,
    value_cents: valueCents,
    currency: 'USD',
    capi_result: result,
  });
}
