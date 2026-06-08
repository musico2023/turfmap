/**
 * POST /api/admin/trigger-nap-audit
 *
 * Diagnostic + manual-recovery endpoint for the NAP audit pipeline.
 * Synchronously runs `triggerNapAuditAtAuditInit` (which auto-enriches
 * the location's NAP fields from Google Places when missing, then
 * calls `maybeRunNapAudit`) for a given visibility_audits row.
 * Returns the full, untruncated result so an operator can see
 * whether enrichment / DFS audit fired and what stage failed when
 * it didn't.
 *
 * Built 2026-06-08 because the bootstrap-comp-audit fire-and-forget
 * NAP trigger silently failed for CertaPro — visibility_audits row
 * created, NAP-ready location, but zero nap_audits rows landed +
 * the regenerate path's awaited trigger ALSO produced no row. We
 * need direct visibility into the trigger's return value to figure
 * out which stage is failing.
 *
 * Auth: same shape as /api/admin/bootstrap-comp-audit — agency-owner
 * email session OR `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Body: { audit_id: string }
 *   - audit_id is the visibility_audits row id whose NAP audit
 *     should be triggered. Look it up via SQL or the agency
 *     dashboard's audit deliverable card.
 *
 * Response: full TriggerNapAuditResult from the helper, plus a
 * snapshot of the most recent nap_audits row for the client so the
 * caller can confirm a row actually landed.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';
import { getServerSupabase } from '@/lib/supabase/server';
import { triggerNapAuditAtAuditInit } from '@/lib/audit/triggerNapAuditAtAuditInit';
import type { VisibilityAuditRow, NapAuditRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({
  audit_id: z.string().uuid(),
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
    /* fall through */
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
            : 'invalid body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Confirm the audit exists + pull client_id for the post-run row
  // snapshot below.
  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('id, client_id')
    .eq('id', body.audit_id)
    .maybeSingle<Pick<VisibilityAuditRow, 'id' | 'client_id'>>();
  if (!audit) {
    return NextResponse.json(
      { error: `visibility_audits row not found: ${body.audit_id}` },
      { status: 404 }
    );
  }

  // Capture pre-state so the operator can see whether a row actually
  // landed during this invocation (vs. an old row from an earlier
  // attempt).
  const { data: napBefore } = await supabase
    .from('nap_audits')
    .select('id, status, error_message, created_at, completed_at')
    .eq('client_id', audit.client_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<NapAuditRow, 'id' | 'status' | 'error_message' | 'created_at' | 'completed_at'>
    >();

  const origin = new URL(req.url).origin;
  const result = await triggerNapAuditAtAuditInit(supabase, body.audit_id, {
    operatorOrigin: origin,
  });

  // Snapshot the most recent nap_audits row AFTER the trigger so the
  // operator can see whether a new row landed + what state it's in.
  const { data: napAfter } = await supabase
    .from('nap_audits')
    .select(
      'id, status, provider, total_citations, inconsistencies_count, missing_high_priority_count, error_message, created_at, completed_at'
    )
    .eq('client_id', audit.client_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<
        NapAuditRow,
        | 'id'
        | 'status'
        | 'provider'
        | 'total_citations'
        | 'inconsistencies_count'
        | 'missing_high_priority_count'
        | 'error_message'
        | 'created_at'
        | 'completed_at'
      >
    >();

  return NextResponse.json({
    audit_id: body.audit_id,
    client_id: audit.client_id,
    trigger_result: result,
    nap_audit_before: napBefore,
    nap_audit_after: napAfter,
    new_row_landed:
      napAfter !== null && (napBefore === null || napAfter.id !== napBefore.id),
  });
}
