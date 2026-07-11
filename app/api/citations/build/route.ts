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
import { provisionGhlListingsLocation } from '@/lib/ghl/listings';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';
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

  // Operator contact — required by both vendors (BL campaign contact /
  // GHL sub-account prospect info). Derived from the agency user
  // submitting the order (we don't collect a buyer-side contact).
  const contact = splitContactName(auth.full_name, auth.email);

  // ─── GHL Listings path (citations vendor v2, flag-gated) ──────────────
  // When GHL_LISTINGS_ENABLED=true, orders fulfil via GoHighLevel Listings
  // (Uberall engine, no location cap) instead of BrightLocal (walled at 1
  // active location on our plan). The BL code below stays intact as the
  // flag-off path / rollback.
  if (process.env.GHL_LISTINGS_ENABLED === 'true') {
    return handleGhlListingsBuild(supabase, parsed, contact);
  }

  // ─── Submit to BL ─────────────────────────────────────────────────────
  const result = await submitCitationOrder({
    profile: parsed.profile,
    industry: parsed.industry ?? null,
    contact,
    locationReference: parsed.location_id,
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

  // Map the confirm outcome to a persisted status. The campaign was
  // CREATED on BL either way, so we always persist (never orphan it):
  //   confirmed        → queued (paid, submissions queued)
  //   awaiting_confirm → BL's citation lookup is still running; the
  //                      poll-citations cron finalizes it once it's done
  //   confirm_failed   → a real confirm error; store it for follow-up
  const orderStatus =
    result.confirmState === 'confirmed'
      ? 'queued'
      : result.confirmState === 'awaiting_confirm'
        ? 'awaiting_confirm'
        : 'failed';

  const { data: row, error: insertErr } = await supabase
    .from('citation_orders')
    .insert({
      client_id: parsed.client_id,
      location_id: parsed.location_id,
      brightlocal_order_id: result.orderId,
      status: orderStatus,
      per_directory: initialPerDirectory,
      wholesale_cents: result.wholesaleCents,
      submitted_profile: parsed.profile,
      error:
        result.confirmState === 'confirm_failed'
          ? (result.confirmMessage ?? 'confirm failed')
          : null,
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

  // confirm_failed is a real error — surface it (order persisted as
  // 'failed' so it's not lost). awaiting/confirmed both succeed; awaiting
  // gets a "finalizing" note so the operator knows it's not instant.
  if (result.confirmState === 'confirm_failed') {
    return NextResponse.json(
      {
        ok: false,
        order: row,
        error: `Campaign ${result.orderId} created but confirm failed: ${result.confirmMessage ?? 'unknown'}`,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    order: row,
    confirm_state: result.confirmState,
    message:
      result.confirmState === 'awaiting_confirm'
        ? "Submitted. BrightLocal is verifying citations — the order finalizes automatically within the hour (no re-submit needed)."
        : 'Citations submitted.',
  });
}

/**
 * GHL Listings build: provision a GHL sub-account carrying the profile,
 * persist the order as 'awaiting_activation', and ping the operator to
 * flip Listings ON (no public API for that toggle — one UI click). The
 * order NEVER fails just because provisioning is plan-gated or the agency
 * token is missing: it persists with ghl_location_id=null and the ping
 * asks the operator to create the sub-account manually (available on
 * every GHL plan).
 */
async function handleGhlListingsBuild(
  supabase: ReturnType<typeof getServerSupabase>,
  parsed: z.infer<typeof Body>,
  contact: { firstname: string; lastname: string; email: string }
): Promise<NextResponse> {
  const provision = await provisionGhlListingsLocation({
    profile: parsed.profile,
    contact,
    locationReference: parsed.location_id,
  });

  // Hard failures only: a bad profile or the flag being off. Everything
  // else (plan gate, remote hiccup) degrades to manual provisioning so
  // the buyer-facing flow never blocks on GHL.
  if (!provision.ok && provision.kind === 'invalid_profile') {
    return NextResponse.json({ error: provision.message }, { status: 400 });
  }
  if (!provision.ok && provision.kind === 'not_configured') {
    return NextResponse.json({ error: provision.message }, { status: 503 });
  }
  const ghlLocationId = provision.ok ? provision.ghlLocationId : null;

  const { data: row, error: insertErr } = await supabase
    .from('citation_orders')
    .insert({
      client_id: parsed.client_id,
      location_id: parsed.location_id,
      provider: 'ghl_listings',
      ghl_location_id: ghlLocationId,
      brightlocal_order_id: null,
      status: 'awaiting_activation',
      per_directory: [],
      // Monthly wholesale (GHL bills $30/mo per sub-account with Listings
      // enabled). Semantics differ from BL's one-time campaign cost — the
      // dashboard cost rollup reads this as "current monthly COGS".
      wholesale_cents: 3000,
      submitted_profile: parsed.profile,
      error: provision.ok ? null : provision.message,
    })
    .select('*')
    .single<CitationOrderRow>();

  if (insertErr || !row) {
    const code = (insertErr as { code?: string } | null)?.code;
    if (code === '23P01') {
      const { data: existing } = await supabase
        .from('citation_orders')
        .select('id, status, provider')
        .eq('location_id', parsed.location_id)
        .eq('maintenance_paused', false)
        .neq('status', 'failed')
        .maybeSingle<Pick<CitationOrderRow, 'id' | 'status' | 'provider'>>();
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
        error: `Local insert failed: ${insertErr?.message ?? 'unknown'}${ghlLocationId ? ` (GHL sub-account ${ghlLocationId} was created — operator follow-up required)` : ''}`,
      },
      { status: 500 }
    );
  }

  // Operator ping — the activation step is manual by necessity. Fail-soft:
  // a Slack hiccup must not fail the order (the dashboard panel shows the
  // same "awaiting activation" state as backstop).
  const p = parsed.profile;
  const napLine = [p.street_address, p.city, p.region, p.postcode]
    .filter(Boolean)
    .join(', ');
  try {
    await postOperatorSlack({
      text: ghlLocationId
        ? `📇 Citations: GHL sub-account created for ${p.business_name} (${napLine}). Next: toggle Listings ON for sub-account ${ghlLocationId} in the GHL agency dashboard, then hit "Mark activated" on the TurfMap citations panel.`
        : `📇 Citations: order queued for ${p.business_name} (${napLine}) but the GHL sub-account needs MANUAL creation (${provision.ok ? '' : provision.message}). Create it in the GHL agency dashboard, toggle Listings ON, then hit "Mark activated" on the TurfMap citations panel.`,
    });
  } catch {
    /* fail-soft */
  }

  return NextResponse.json({
    ok: true,
    order: row,
    message:
      'Listings order submitted. Your profile is being set up across 70+ directories — the panel updates once syncing is activated.',
  });
}

/** Split a free-form full name into first + last. Single-word names
 *  reuse the word for both fields (BL requires both to be non-empty).
 *  Falls back to the email local-part when no name is on the user
 *  record. */
function splitContactName(
  fullName: string | null,
  email: string
): { firstname: string; lastname: string; email: string } {
  const raw = fullName?.trim() || email.split('@')[0]!;
  const parts = raw.split(/\s+/).filter(Boolean);
  const firstname = parts[0] ?? raw;
  const lastname = parts.length > 1 ? parts.slice(1).join(' ') : firstname;
  return { firstname, lastname, email };
}
