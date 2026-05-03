/**
 * POST /api/clients — onboard a new client.
 *
 * Body:
 *   {
 *     business_name, address, latitude, longitude,
 *     industry?, service_radius_miles?, primary_color?, monthly_price_cents?,
 *     status?,
 *     keyword: { keyword, scan_frequency?, is_primary? }
 *   }
 *
 * Creates a `clients` row and one `tracked_keywords` row in a single
 * (best-effort transactional) flow. If the keyword insert fails, we delete
 * the client row to avoid orphans.
 *
 * Returns: { id, slug } on success, or { error } on failure.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { ClientStatus, ScanFrequency } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const CreateClientBody = z.object({
  business_name: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Structured NAP fields — required by BrightLocal Listings API. Optional
  // here so older API consumers don't break, but the create form sends them.
  phone: z.string().min(4).max(40).optional().nullable(),
  street_address: z.string().min(1).max(200).optional().nullable(),
  city: z.string().min(1).max(120).optional().nullable(),
  region: z.string().min(1).max(120).optional().nullable(),
  postcode: z.string().min(1).max(20).optional().nullable(),
  country_code: z
    .string()
    .length(3, 'ISO-3166-1 alpha-3 (e.g. USA)')
    .optional()
    .nullable(),
  industry: z.string().max(80).optional().nullable(),
  service_radius_miles: z.number().min(0.1).max(10).optional(),
  primary_color: z
    .string()
    .regex(HEX_COLOR, 'must be hex like #c5ff3a')
    .optional(),
  monthly_price_cents: z.number().int().min(0).optional().nullable(),
  status: z.enum(['active', 'paused', 'churned']).optional(),
  keyword: z.object({
    keyword: z.string().min(2).max(160),
    scan_frequency: z
      .enum(['daily', 'weekly', 'biweekly', 'monthly'])
      .optional(),
    is_primary: z.boolean().optional(),
  }),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  let parsed: z.infer<typeof CreateClientBody>;
  try {
    parsed = CreateClientBody.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // 1. Insert client
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({
      business_name: parsed.business_name,
      address: parsed.address,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      phone: parsed.phone ?? null,
      street_address: parsed.street_address ?? null,
      city: parsed.city ?? null,
      region: parsed.region ?? null,
      postcode: parsed.postcode ?? null,
      country_code: parsed.country_code ?? 'USA',
      industry: parsed.industry ?? null,
      service_radius_miles: parsed.service_radius_miles ?? 1.6,
      primary_color: parsed.primary_color ?? '#c5ff3a',
      monthly_price_cents: parsed.monthly_price_cents ?? null,
      status: (parsed.status ?? 'active') as ClientStatus,
    })
    .select('id')
    .single();

  if (clientErr || !client) {
    return NextResponse.json(
      { error: `client insert failed: ${clientErr?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  // 2. Insert primary keyword. Roll back the client on failure to avoid orphan.
  const { error: kwErr } = await supabase.from('tracked_keywords').insert({
    client_id: client.id,
    keyword: parsed.keyword.keyword,
    scan_frequency: (parsed.keyword.scan_frequency ?? 'weekly') as ScanFrequency,
    is_primary: parsed.keyword.is_primary ?? true,
  });

  if (kwErr) {
    await supabase.from('clients').delete().eq('id', client.id);
    return NextResponse.json(
      { error: `keyword insert failed (client rolled back): ${kwErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ id: client.id });
}
