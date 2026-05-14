/**
 * PATCH /api/clients/[id] — partial update of a client.
 * DELETE /api/clients/[id] — permanent delete with type-to-confirm guard.
 *
 * PATCH body: any subset of the editable client fields, Zod-validated.
 *
 * DELETE body: { confirm_business_name: string } — must match the row's
 * `business_name` exactly (case-sensitive, whitespace-trimmed). This is the
 * GitHub-repo-delete pattern: a real "I really mean it" gesture beats a
 * confirm() click that operators learn to muscle-memory through. Cascade is
 * intentional — the row's scans, scan_points, ai_insights, competitors,
 * tracked_keywords, and client_users all go with it.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { pauseClientCitationMaintenance } from '@/lib/citations/maintenance';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const PatchBody = z
  .object({
    business_name: z.string().min(2).max(200),
    address: z.string().min(4).max(400),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    pin_lat: z.number().min(-90).max(90).nullable(),
    pin_lng: z.number().min(-180).max(180).nullable(),
    // Structured NAP fields for BrightLocal Listings audit. Nullable so an
    // operator can clear a field that was set in error.
    phone: z.string().min(4).max(40).nullable(),
    street_address: z.string().min(1).max(200).nullable(),
    city: z.string().min(1).max(120).nullable(),
    region: z.string().min(1).max(120).nullable(),
    postcode: z.string().min(1).max(20).nullable(),
    country_code: z.string().length(3, 'ISO-3166-1 alpha-3 (e.g. USA)').nullable(),
    industry: z.string().max(80).nullable(),
    service_radius_miles: z.number().min(0.1).max(10),
    primary_color: z.string().regex(HEX_COLOR, 'must be hex like #c5ff3a'),
    logo_url: z.string().url().max(2048).nullable(),
    monthly_price_cents: z.number().int().min(0).nullable(),
    status: z.enum(['active', 'paused', 'churned']),
    /** Pulse / Pulse+ alert preferences. Partial merge — caller flips
     *  one toggle without resending the rest; merged against
     *  existing on the row. */
    alert_prefs: z
      .object({
        score_movement_email: z.boolean().optional(),
        score_movement_threshold: z.number().int().min(1).max(100).optional(),
        competitor_entries_email: z.boolean().optional(),
        momentum_reversal_email: z.boolean().optional(),
        cell_changes_email: z.boolean().optional(),
        weekly_competitor_summary_email: z.boolean().optional(),
      })
      .partial(),
    /** Slack incoming-webhook URL. null clears. Slack-host-validated. */
    slack_webhook_url: z
      .string()
      .url()
      .regex(
        /^https:\/\/hooks\.slack\.com\//,
        'must be a https://hooks.slack.com/... URL'
      )
      .nullable(),
  })
  .partial()
  // At least one field — empty body is a useless call.
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;

  let parsed: z.infer<typeof PatchBody>;
  try {
    parsed = PatchBody.parse(await req.json());
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
  // Tolerant lookup — public_id (default) or legacy UUID.
  const existing = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!existing) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  const id = existing.id;

  // Dual-write: clients gets EVERYTHING (location columns are deprecated
  // mirrors), client_locations.primary gets the location-shaped subset.
  // Once every read site has been migrated to client_locations, the
  // mirror columns get dropped in a follow-up migration and this route
  // splits cleanly into brand-only updates.
  const LOCATION_KEYS = [
    'address',
    'latitude',
    'longitude',
    'pin_lat',
    'pin_lng',
    'phone',
    'street_address',
    'city',
    'region',
    'postcode',
    'country_code',
    'service_radius_miles',
  ] as const;
  const locationPatch: Record<string, unknown> = {};
  for (const k of LOCATION_KEYS) {
    if (k in parsed) locationPatch[k] = (parsed as Record<string, unknown>)[k];
  }

  // Merge alert_prefs against the existing row's value so a PATCH
  // with `{ alert_prefs: { score_movement_email: false } }` flips one
  // toggle without erasing the other keys.
  const updateBody: Record<string, unknown> = { ...parsed };
  if (parsed.alert_prefs && existing.alert_prefs) {
    updateBody.alert_prefs = {
      ...existing.alert_prefs,
      ...parsed.alert_prefs,
    };
  }

  const { data: updated, error } = await supabase
    .from('clients')
    .update(updateBody)
    .eq('id', id)
    .select('*')
    .maybeSingle<ClientRow>();

  if (error) {
    return NextResponse.json(
      { error: `update failed: ${error.message}` },
      { status: 500 }
    );
  }
  if (!updated) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // Mirror the location-shaped fields onto the primary location row.
  // Best-effort: if it fails we still return the clients row and log;
  // the operator's edit isn't lost (it landed on clients), it just
  // didn't propagate to client_locations. Future audits + scans would
  // see stale location data until the next save.
  if (Object.keys(locationPatch).length > 0) {
    const { error: locErr } = await supabase
      .from('client_locations')
      .update(locationPatch)
      .eq('client_id', id)
      .eq('is_primary', true);
    if (locErr) {
      console.error(
        `[/api/clients/${id}] primary location dual-write failed:`,
        locErr.message
      );
    }
  }

  // Tier-downgrade hook — when status flips to 'churned', pause
  // ongoing citation maintenance (BL stops being charged for sync;
  // existing live citations stay live but no longer update). The
  // Stripe webhook (item 2 in the roadmap) plumbs the same helper
  // for buyer-side cancellations once that lands.
  if (parsed.status === 'churned' && existing.status !== 'churned') {
    const { paused, blFailures } = await pauseClientCitationMaintenance(
      supabase,
      id
    );
    if (paused > 0) {
      console.log(
        `[/api/clients/${id}] paused ${paused} citation_orders on churn (BL failures: ${blFailures.length})`
      );
    }
  }

  return NextResponse.json(updated);
}

const DeleteBody = z.object({
  confirm_business_name: z.string().min(1),
});

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;

  let parsed: z.infer<typeof DeleteBody>;
  try {
    parsed = DeleteBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'confirm_business_name is required' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Tolerant lookup — public_id or legacy UUID.
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  const id = client.id;

  if (parsed.confirm_business_name.trim() !== client.business_name) {
    return NextResponse.json(
      {
        error:
          'confirm_business_name must exactly match the client business name',
      },
      { status: 400 }
    );
  }

  // Capture cascade counts so the UI can show "deleted X scans, Y keywords".
  // These are best-effort — if a count query fails, we still proceed.
  const [{ count: scanCount }, { count: keywordCount }] = await Promise.all([
    supabase
      .from('scans')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id),
    supabase
      .from('tracked_keywords')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id),
  ]);

  const { error: delErr } = await supabase.from('clients').delete().eq('id', id);
  if (delErr) {
    return NextResponse.json(
      { error: `delete failed: ${delErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      client_id: id,
      business_name: client.business_name,
      scans: scanCount ?? 0,
      keywords: keywordCount ?? 0,
    },
  });
}
