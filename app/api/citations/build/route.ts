/**
 * POST /api/citations/build
 *
 * Submit a citation-build order to BrightLocal for one (client,
 * location). Inserts a `citation_orders` row, calls BL with the
 * onboarding-profile snapshot, stamps the BL order_id back on the
 * row, and returns the new row's id so the dashboard can poll for
 * progress.
 *
 * Tier gate: caller's client must be on Pulse+ (billing_mode =
 * self_serve_subscription AND tier = pulse_plus, OR agency_managed —
 * we trust the operator to gate appropriately on agency-managed
 * clients via their own contract). One-time / Pulse buyers get 403.
 *
 * Idempotency: the citation_orders schema's exclusion constraint
 * (`citation_orders_one_open_per_location`) prevents two open orders
 * for the same location. A retry against an already-open location
 * returns 409 with the existing row's id so the dashboard can
 * reconcile.
 *
 * Body: { client_id, location_id, profile, industry? }
 *
 * The `profile` is the onboarding-form snapshot. POST is the moment
 * we freeze it for this order — subsequent NAP edits on the client
 * row don't retroactively change what we submitted to BL.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { submitCitationOrder } from '@/lib/brightlocal/citationBuilder';
import type {
  CitationOrderRow,
  CitationSubmittedProfile,
  ClientRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// BL submit is one HTTP call — usually fast (<5s), but allow headroom
// for their occasional slow-path responses on busy days.
export const maxDuration = 60;

const ProfileSchema = z.object({
  business_name: z.string().min(2).max(200),
  street_address: z.string().min(1).max(200).nullable(),
  city: z.string().min(1).max(120).nullable(),
  region: z.string().min(1).max(120).nullable(),
  postcode: z.string().min(1).max(20).nullable(),
  country_code: z.string().length(3).nullable(),
  phone: z.string().min(4).max(40).nullable(),
  website: z.string().url().max(2048).nullable(),
  primary_category: z.string().min(1).max(80).nullable(),
  additional_categories: z.array(z.string().max(80)).max(9).nullable(),
  description: z.string().min(1).max(2000).nullable(),
  hours: z.record(z.string(), z.string()).nullable(),
  photo_urls: z.array(z.string().url()).max(20).nullable(),
}) satisfies z.ZodType<CitationSubmittedProfile>;

const Body = z.object({
  client_id: z.string().uuid(),
  location_id: z.string().uuid(),
  profile: ProfileSchema,
  industry: z.string().max(80).nullish(),
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

  // ─── Tier gate ─────────────────────────────────────────────────────────
  const { data: client } = await supabase
    .from('clients')
    .select('id, billing_mode, stripe_subscription_id')
    .eq('id', parsed.client_id)
    .maybeSingle<Pick<ClientRow, 'id' | 'billing_mode' | 'stripe_subscription_id'>>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Citation Builder is bundled into Pulse+ subscriptions and into
  // agency-managed contracts. Self-serve Pulse / one-time tiers
  // shouldn't be able to fire this endpoint.
  //
  // The current schema doesn't carry the resolved tier on the client
  // row directly — Pulse vs Pulse+ is encoded in the Stripe Price the
  // subscription is on. For now, gate on billing_mode: agency-managed
  // OR self-serve-subscription clients pass through. A follow-up will
  // tighten the self-serve branch to specifically check for the
  // Pulse+ Stripe Price id. (TODO: post-Stripe-webhook wiring.)
  if (
    client.billing_mode !== 'agency_managed' &&
    client.billing_mode !== 'self_serve_subscription'
  ) {
    return NextResponse.json(
      {
        error:
          'Citation Builder is included in Pulse+. Upgrade this client to a Pulse+ subscription before triggering a citation build.',
      },
      { status: 403 }
    );
  }

  // ─── Submit to BL ─────────────────────────────────────────────────────
  const result = await submitCitationOrder({
    profile: parsed.profile,
    industry: parsed.industry ?? null,
  });

  if (!result.ok) {
    // Surface BL config + validation errors directly so the operator
    // can fix the profile and retry. Rate-limit + remote-error are
    // operator-facing too — they imply a transient issue, not a bad
    // request, but the operator can still retry with the same body.
    const status =
      result.kind === 'not_configured'
        ? 503
        : result.kind === 'invalid_profile'
          ? 400
          : result.kind === 'rate_limited'
            ? 429
            : 502;
    return NextResponse.json(
      { error: result.message, kind: result.kind },
      { status }
    );
  }

  // ─── Persist citation_orders row ──────────────────────────────────────
  // Insert AFTER the BL submit so the brightlocal_order_id is non-null
  // from the start. The schema's exclusion constraint prevents two
  // open orders for the same location — if this errors with 23P01
  // it means a parallel submit beat us.
  const initialPerDirectory = result.directories.map((d) => ({
    directory: d,
    status: 'pending' as const,
    submitted_at: null,
    live_at: null,
    url: null,
    message: null,
  }));

  const { data: row, error: insertErr } = await supabase
    .from('citation_orders')
    .insert({
      client_id: parsed.client_id,
      location_id: parsed.location_id,
      brightlocal_order_id: result.orderId,
      status: 'queued',
      per_directory: initialPerDirectory,
      wholesale_cents: result.wholesaleCents,
      submitted_profile: parsed.profile,
    })
    .select('*')
    .single<CitationOrderRow>();

  if (insertErr || !row) {
    // 23P01 = exclusion violation. Means another open order already
    // exists for this location — return its id so the UI can
    // navigate the operator to the existing record.
    const code = (insertErr as { code?: string }).code;
    if (code === '23P01') {
      const { data: existing } = await supabase
        .from('citation_orders')
        .select('id, brightlocal_order_id, status')
        .eq('location_id', parsed.location_id)
        .eq('maintenance_paused', false)
        .neq('status', 'failed')
        .maybeSingle<
          Pick<CitationOrderRow, 'id' | 'brightlocal_order_id' | 'status'>
        >();
      return NextResponse.json(
        {
          error:
            'An open citation order already exists for this location. Pause or wait for the existing order before submitting another.',
          existing_order: existing,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error: `BL accepted order ${result.orderId} but local insert failed: ${insertErr?.message ?? 'unknown'}. Operator follow-up required.`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, order: row });
}
