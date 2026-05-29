/**
 * POST /api/admin/disable-cold-stage3
 *
 * Manually halt the cold-stage3 Visibility Audit auto-pitch for one
 * or more prospects so the operator can handle the audit offer
 * personably in-thread instead of letting the founder-from-Anthony
 * automated email fire.
 *
 * Stamps prospects.stage_3_disabled_at to now() for each provided
 * prospect/email. cold-stage3 cron's candidate query filters
 * `stage_3_disabled_at IS NULL`, so disabled prospects drop out of
 * the auto-pitch sweep on the very next tick.
 *
 * Body (one or more):
 *   { prospect_id: "..." }
 *   { email: "buyer@example.com" }
 *   { prospect_ids: ["...", "...", "..."] }   // bulk halt
 *   { emails: ["a@x.com", "b@x.com"] }        // bulk halt
 *
 * Auth: agency-owner-domain Supabase session OR `Authorization:
 * Bearer ${CRON_SECRET}`.
 *
 * Idempotent — re-running for already-disabled prospects is a no-op
 * (the conditional `.is('stage_3_disabled_at', null)` on the UPDATE
 * prevents overwrites).
 *
 * To RE-ENABLE the cron auto-pitch for a prospect, manually NULL the
 * column via SQL (no operator endpoint for that — re-enabling is
 * intentional, not a hot path).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  prospect_id: z.string().min(4).max(64).optional(),
  email: z.string().email().optional(),
  prospect_ids: z.array(z.string().min(4).max(64)).max(100).optional(),
  emails: z.array(z.string().email()).max(100).optional(),
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
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  // Collect target identifiers from the four input shapes.
  const targetIds = new Set<string>();
  const targetEmails = new Set<string>();
  if (body.prospect_id) targetIds.add(body.prospect_id);
  if (body.email) targetEmails.add(body.email.trim().toLowerCase());
  if (body.prospect_ids) body.prospect_ids.forEach((id) => targetIds.add(id));
  if (body.emails)
    body.emails.forEach((e) => targetEmails.add(e.trim().toLowerCase()));

  if (targetIds.size === 0 && targetEmails.size === 0) {
    return NextResponse.json(
      {
        error:
          'one of {prospect_id, email, prospect_ids, emails} is required',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const nowIso = new Date().toISOString();
  const disabled: Array<{ id: string; email: string | null }> = [];
  const notFound: string[] = [];

  // Resolve emails → prospect ids. Case-insensitive lookup matches
  // however the prospect was inserted.
  for (const email of targetEmails) {
    const { data } = await supabase
      .from('prospects')
      .select('id')
      .ilike('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (data?.id) {
      targetIds.add(data.id);
    } else {
      notFound.push(email);
    }
  }

  // Bulk stamp. Conditional .is('stage_3_disabled_at', null) keeps
  // the UPDATE idempotent — re-runs for already-disabled prospects
  // won't move the timestamp.
  for (const id of targetIds) {
    const { data, error } = await supabase
      .from('prospects')
      .update({ stage_3_disabled_at: nowIso })
      .eq('id', id)
      .is('stage_3_disabled_at', null)
      .select('id, email')
      .maybeSingle<{ id: string; email: string | null }>();
    if (error) {
      console.error('[disable-cold-stage3] update failed for', id, error.message);
      continue;
    }
    if (data) {
      disabled.push({ id: data.id, email: data.email });
    } else {
      // Already disabled or row not found. Probe to differentiate.
      const { data: probe } = await supabase
        .from('prospects')
        .select('id, email, stage_3_disabled_at')
        .eq('id', id)
        .maybeSingle<{
          id: string;
          email: string | null;
          stage_3_disabled_at: string | null;
        }>();
      if (!probe) notFound.push(id);
      // If probe exists with stage_3_disabled_at set, it's a no-op
      // (idempotency working as designed). We intentionally don't
      // surface "already_disabled" in the response — the caller's
      // intent (halt) is satisfied either way.
    }
  }

  return NextResponse.json({
    ok: true,
    disabled,
    not_found: notFound,
    count: disabled.length,
  });
}
