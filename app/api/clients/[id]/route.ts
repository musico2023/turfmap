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
    industry: z.string().max(80).nullable(),
    service_radius_miles: z.number().min(0.1).max(10),
    primary_color: z.string().regex(HEX_COLOR, 'must be hex like #c5ff3a'),
    logo_url: z.string().url().max(2048).nullable(),
    monthly_price_cents: z.number().int().min(0).nullable(),
    status: z.enum(['active', 'paused', 'churned']),
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
  const { id } = await params;

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
  const { data: updated, error } = await supabase
    .from('clients')
    .update(parsed)
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

  return NextResponse.json(updated);
}

const DeleteBody = z.object({
  confirm_business_name: z.string().min(1),
});

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

  // Load the row so we can verify the confirmation matches.
  const { data: client } = await supabase
    .from('clients')
    .select('id, business_name')
    .eq('id', id)
    .maybeSingle<Pick<ClientRow, 'id' | 'business_name'>>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

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
