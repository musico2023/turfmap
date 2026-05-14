/**
 * Buyer-side onboarding wizard endpoint.
 *
 * Used by /order/success after a self-serve subscription buyer
 * completes the intake form. Auth: stripe_session_id ↔ lead_orders
 * → clients (see lib/auth/onboarding.ts) — the buyer doesn't have a
 * portal session yet, so we use the Checkout session id as proof of
 * ownership for the client they paid for.
 *
 * GET   — returns wizard state + the data each step needs:
 *           { step, gbp, locationId, hasSiblingsOrCompetitors }
 * POST  — action discriminator:
 *           { action: 'advance', step: <next-step> }            — explicit step set
 *           { action: 'gbp_confirm' }                            — confirm auto-match
 *           { action: 'gbp_reject' }                             — clear match + flag rejected
 *           { action: 'gbp_search', query }                      — Places text search
 *           { action: 'gbp_select', placeId }                    — operator picks a candidate
 *           { action: 'invite_user', email }                     — portal-user invite
 *           { action: 'add_competitor', name }                   — Pulse+ only
 *
 * Each request includes `sessionId` in body (POST) or query (GET) so
 * the auth gate has something to verify. POST advances `clients.
 * onboarding_step` automatically when the action is the last logical
 * step in its bucket; explicit advance/skip uses the 'advance' action.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireOnboardingSession } from '@/lib/auth/onboarding';
import {
  confirmMatch,
  rejectMatch,
  selectMatchManually,
  getLatestSignals,
  type GbpSignalsRow,
} from '@/lib/google/enrich';
import { searchPlaces } from '@/lib/google/places';
import { sendPortalInviteEmail } from '@/lib/portal/invite';
import type {
  ClientLocationRow,
  ClientRow,
  OnboardingStep,
  SubscriptionTier,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PORTAL_USERS_PER_CLIENT = 5;
const COMPETITOR_CAP_ON_WIZARD = 3;

const PostBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('advance'),
    step: z.enum(['gbp_match', 'portal_users', 'competitors', 'done']),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('gbp_confirm'),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('gbp_reject'),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('gbp_search'),
    query: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('gbp_select'),
    placeId: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('invite_user'),
    email: z.string().email().max(254),
    sessionId: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal('add_competitor'),
    name: z.string().min(1).max(120),
    sessionId: z.string().min(1).max(300),
  }),
]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const { publicId } = await params;
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  const supabase = getServerSupabase();
  const auth = await requireOnboardingSession(supabase, {
    sessionId,
    publicIdOrUuid: publicId,
  });
  if (!auth.ok) return auth.response;

  const state = await loadState(supabase, auth.clientId);
  return NextResponse.json(state);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ publicId: string }> }
) {
  const { publicId } = await params;

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const auth = await requireOnboardingSession(supabase, {
    sessionId: body.sessionId,
    publicIdOrUuid: publicId,
  });
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  switch (body.action) {
    case 'advance': {
      const { error } = await supabase
        .from('clients')
        .update({ onboarding_step: body.step })
        .eq('id', clientId);
      if (error) {
        return NextResponse.json(
          { error: `update failed: ${error.message}` },
          { status: 500 }
        );
      }
      const state = await loadState(supabase, clientId);
      return NextResponse.json(state);
    }

    case 'gbp_confirm':
    case 'gbp_reject': {
      const locationId = await primaryLocationId(supabase, clientId);
      if (!locationId) {
        return NextResponse.json(
          { error: 'primary location not found' },
          { status: 404 }
        );
      }
      const ok =
        body.action === 'gbp_confirm'
          ? await confirmMatch(supabase, locationId)
          : await rejectMatch(supabase, locationId);
      if (!ok) {
        return NextResponse.json({ error: 'update failed' }, { status: 500 });
      }
      // gbp_confirm advances to next step automatically. gbp_reject
      // stays on this step so the buyer can search/select.
      if (body.action === 'gbp_confirm') {
        await supabase
          .from('clients')
          .update({ onboarding_step: 'portal_users' })
          .eq('id', clientId);
      }
      const state = await loadState(supabase, clientId);
      return NextResponse.json(state);
    }

    case 'gbp_search': {
      if (!process.env.GOOGLE_PLACES_API_KEY) {
        return NextResponse.json(
          { error: 'GOOGLE_PLACES_API_KEY is not configured' },
          { status: 503 }
        );
      }
      const locationId = await primaryLocationId(supabase, clientId);
      if (!locationId) {
        return NextResponse.json(
          { error: 'primary location not found' },
          { status: 404 }
        );
      }
      const { data: loc } = await supabase
        .from('client_locations')
        .select('latitude, longitude')
        .eq('id', locationId)
        .maybeSingle<Pick<ClientLocationRow, 'latitude' | 'longitude'>>();
      const result = await searchPlaces({
        query: body.query,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
      });
      return NextResponse.json({ candidates: result.candidates });
    }

    case 'gbp_select': {
      if (!process.env.GOOGLE_PLACES_API_KEY) {
        return NextResponse.json(
          { error: 'GOOGLE_PLACES_API_KEY is not configured' },
          { status: 503 }
        );
      }
      const locationId = await primaryLocationId(supabase, clientId);
      if (!locationId) {
        return NextResponse.json(
          { error: 'primary location not found' },
          { status: 404 }
        );
      }
      const ok = await selectMatchManually(supabase, {
        locationId,
        placeId: body.placeId,
      });
      if (!ok) {
        return NextResponse.json(
          { error: 'place lookup or update failed' },
          { status: 502 }
        );
      }
      // Manual select advances past the GBP step automatically.
      await supabase
        .from('clients')
        .update({ onboarding_step: 'portal_users' })
        .eq('id', clientId);
      const state = await loadState(supabase, clientId);
      return NextResponse.json(state);
    }

    case 'invite_user': {
      const email = body.email.trim().toLowerCase();
      const { count } = await supabase
        .from('client_users')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId);
      if ((count ?? 0) >= PORTAL_USERS_PER_CLIENT) {
        return NextResponse.json(
          {
            error: `portal-user cap reached (${PORTAL_USERS_PER_CLIENT} per client)`,
          },
          { status: 400 }
        );
      }
      const { data, error } = await supabase
        .from('client_users')
        .insert({ client_id: clientId, email })
        .select('id, email')
        .single<{ id: string; email: string }>();
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505') {
          return NextResponse.json(
            { error: 'this email already belongs to a portal account' },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: `insert failed: ${error.message}` },
          { status: 500 }
        );
      }
      const origin = req.headers.get('origin') ?? new URL(req.url).origin;
      const inviteResult = await sendPortalInviteEmail({
        supabase,
        clientId,
        email,
        origin,
      });
      if (inviteResult.ok) {
        await supabase
          .from('client_users')
          .update({ invited_at: new Date().toISOString() })
          .eq('id', data.id);
      }
      return NextResponse.json({
        invited: { id: data.id, email: data.email },
        invite_sent: inviteResult.ok,
      });
    }

    case 'add_competitor': {
      // Tier gate — competitors-on-wizard is Pulse+ only. Pulse buyers
      // can still curate later in settings, but the wizard skips this
      // step for them entirely.
      const { data: clientRow } = await supabase
        .from('clients')
        .select('tier')
        .eq('id', clientId)
        .maybeSingle<Pick<ClientRow, 'tier'>>();
      if ((clientRow?.tier as SubscriptionTier | null) !== 'pulse_plus') {
        return NextResponse.json(
          { error: 'competitor tracking is a Pulse+ feature' },
          { status: 403 }
        );
      }
      const locationId = await primaryLocationId(supabase, clientId);
      if (!locationId) {
        return NextResponse.json(
          { error: 'primary location not found' },
          { status: 404 }
        );
      }
      const { count } = await supabase
        .from('competitors')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .eq('location_id', locationId);
      if ((count ?? 0) >= COMPETITOR_CAP_ON_WIZARD) {
        return NextResponse.json(
          {
            error: `wizard caps competitors at ${COMPETITOR_CAP_ON_WIZARD} — add more later in settings`,
          },
          { status: 400 }
        );
      }
      const { error } = await supabase.from('competitors').insert({
        client_id: clientId,
        location_id: locationId,
        competitor_name: body.name.trim(),
      });
      if (error) {
        return NextResponse.json(
          { error: `insert failed: ${error.message}` },
          { status: 500 }
        );
      }
      const state = await loadState(supabase, clientId);
      return NextResponse.json(state);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type WizardState = {
  step: OnboardingStep | null;
  publicId: string;
  tier: SubscriptionTier | null;
  locationId: string | null;
  gbp: {
    placeId: string | null;
    status:
      | 'auto'
      | 'confirmed'
      | 'manual'
      | 'rejected'
      | 'no_match'
      | null;
    signals: GbpSignalsRow | null;
  };
  portalUserCount: number;
  competitorCount: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

async function loadState(
  supabase: SupabaseLike,
  clientId: string
): Promise<WizardState> {
  const { data: client } = await supabase
    .from('clients')
    .select('public_id, tier, onboarding_step')
    .eq('id', clientId)
    .maybeSingle<
      Pick<ClientRow, 'public_id' | 'tier' | 'onboarding_step'>
    >();
  const locationId = await primaryLocationId(supabase, clientId);
  let gbp: WizardState['gbp'] = {
    placeId: null,
    status: null,
    signals: null,
  };
  if (locationId) {
    const { data: loc } = await supabase
      .from('client_locations')
      .select('google_place_id, google_place_match_status')
      .eq('id', locationId)
      .maybeSingle<
        Pick<
          ClientLocationRow,
          'google_place_id' | 'google_place_match_status'
        >
      >();
    const signals = await getLatestSignals(supabase, locationId);
    gbp = {
      placeId: loc?.google_place_id ?? null,
      status: loc?.google_place_match_status ?? null,
      signals,
    };
  }
  const { count: portalUserCount } = await supabase
    .from('client_users')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);
  const { count: competitorCount } = locationId
    ? await supabase
        .from('competitors')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId)
        .eq('location_id', locationId)
    : { count: 0 };
  return {
    step: client?.onboarding_step ?? null,
    publicId: client?.public_id ?? '',
    tier: client?.tier ?? null,
    locationId,
    gbp,
    portalUserCount: portalUserCount ?? 0,
    competitorCount: competitorCount ?? 0,
  };
}

async function primaryLocationId(
  supabase: SupabaseLike,
  clientId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('client_locations')
    .select('id')
    .eq('client_id', clientId)
    .eq('is_primary', true)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
