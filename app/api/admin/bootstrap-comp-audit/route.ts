/**
 * POST /api/admin/bootstrap-comp-audit
 *
 * Operator-only endpoint to manually bootstrap a comp ($0) Visibility
 * Audit for a cold-outreach prospect who booked the audit Cal.com
 * link before the auto-bootstrap shipped (the Cal.com webhook now
 * handles new bookings automatically, but earlier ones — Yohann at
 * Ainger Group Roofing being the catalyst — need to be reconciled
 * after the fact).
 *
 * Fires the same automation a paid $499 audit would: creates the
 * lead_orders + visibility_audits rows, generates the Roadmap PDF
 * via Claude, emails Anthony the PDF, pings #llm-leads on Slack.
 * Idempotent: a second call for the same buyer reuses the existing
 * visibility_audits row + refreshes the booking timestamp if
 * supplied.
 *
 * Auth: agency-owner-domain email check (fourdots.ca / fourdots.io
 * via Supabase magic-link session) OR `Authorization: Bearer
 * ${CRON_SECRET}` for scripted use.
 *
 * Body: { email?, prospect_id?, client_id?, call_start_time? }
 *   - One of {email, prospect_id, client_id} is required. email is
 *     the typical case (you're reconciling someone Cal.com showed in
 *     your inbox).
 *   - call_start_time optional ISO string when you want to stamp the
 *     audit row's strategist_call_scheduled_at (so the T-24h cron
 *     picks it up). Omit for pre-booking bootstrap.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';
import { bootstrapCompAudit } from '@/lib/audit/bootstrapCompAudit';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  email: z.string().email().optional(),
  prospect_id: z.string().min(4).max(64).optional(),
  client_id: z.string().uuid().optional(),
  /** Operator-friendly fallback when none of email/prospect_id/
   *  client_id resolve. Fuzzy-matches against clients.business_name
   *  ILIKE %name% with is_outreach_lead=true (so we never collapse
   *  a paying client with an outreach lead of the same name). */
  business_name: z.string().min(3).max(200).optional(),
  call_start_time: z.string().datetime().optional(),
  call_uid: z.string().max(120).optional(),
  booker_url: z.string().url().optional(),
  /** When true: if a visibility_audits row already exists for this
   *  client, RE-RUN the PDF generation + re-send Anthony the
   *  operator email. Use when the template/data changed since the
   *  original bootstrap (e.g. PDF copy fixes shipped, NAP audit
   *  just completed, fresh competitor data). Default false. */
  force_regenerate: z.boolean().optional(),
});

async function isAuthorized(req: Request): Promise<boolean> {
  // Path 1: shared cron secret (scripted use).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get('authorization') ?? '';
    if (header === `Bearer ${secret}`) return true;
  }

  // Path 2: agency-owner email session.
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

  if (
    !body.email &&
    !body.prospect_id &&
    !body.client_id &&
    !body.business_name
  ) {
    return NextResponse.json(
      {
        error:
          'one of {email, prospect_id, client_id, business_name} is required to resolve the buyer',
      },
      { status: 400 }
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;

  const result = await bootstrapCompAudit(
    {
      clientId: body.client_id,
      prospectId: body.prospect_id,
      email: body.email ?? null,
      businessName: body.business_name ?? null,
      callStartTime: body.call_start_time ?? null,
      callUid: body.call_uid ?? null,
      bookerUrl: body.booker_url ?? null,
      source: 'admin',
      forceRegenerate: body.force_regenerate ?? false,
    },
    origin
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, stage: result.stage, error: result.error },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    created: result.created,
    audit_id: result.auditId,
    lead_order_id: result.leadOrderId,
    client_id: result.clientId,
    roadmap_pdf_url: result.roadmapPdfUrl,
  });
}
