/**
 * GET /api/audit/[id]/prep-notes
 *
 * Serves the Strategist Prep Notes HTML file for an audit, fetched
 * from Supabase Storage server-side and returned with the correct
 * `Content-Type: text/html` so browsers render it as a styled page.
 *
 * Why a server-side proxy: Supabase Storage forces
 * `Content-Type: text/plain` + `CSP: sandbox` on signed-URL HTML
 * responses as XSS prevention (anyone with a signed URL could
 * otherwise host malicious HTML on the supabase.co origin). Our
 * own `/api` route serves from `www.turfmap.ai` where we control
 * the headers, sidestepping that security boundary.
 *
 * Auth: agency-owner-domain only (anthony@fourdots.io / .ca etc.).
 * Operators are signed in to the agency dashboard 99% of the time
 * when clicking links from Anthony's prep email; if not, they get
 * redirected through the standard sign-in flow.
 */

import { NextResponse } from 'next/server';
import { isAgencyOwnerEmail, requireAgencyUserForApi } from '@/lib/auth/agency';
import { getServerSupabase } from '@/lib/supabase/server';
import { AUDIT_ROADMAPS_BUCKET } from '@/lib/audit/storage';
import type { VisibilityAuditRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  // Auth gate. requireAgencyUserForApi returns the user record on
  // success or a NextResponse 401/redirect on failure. We then
  // additionally check the email is in the fourdots-owner allowlist
  // — these notes are operator-internal, never buyer-facing.
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json({ error: 'fourdots-only' }, { status: 403 });
  }

  const { id: auditId } = await ctx.params;
  if (!auditId) {
    return NextResponse.json({ error: 'audit id required' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // Confirm the audit exists. Strict — we don't serve prep notes for
  // audits that haven't been written. Returns 404 in either case so
  // a probing request can't distinguish "no such audit" from
  // "audit exists but no prep notes generated yet".
  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('id')
    .eq('id', auditId)
    .maybeSingle<Pick<VisibilityAuditRow, 'id'>>();
  if (!audit) {
    return NextResponse.json(
      { error: 'audit not found or no prep notes generated' },
      { status: 404 }
    );
  }

  // Fetch the file content from Storage. Service-role access means
  // we don't need to mint a signed URL just to read the bytes —
  // direct download via the service-role client.
  const path = `${auditId}/prep-notes.html`;
  const { data: blob, error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .download(path);
  if (error || !blob) {
    console.error('[audit/prep-notes] Storage download failed', {
      auditId,
      path,
      error: error?.message,
    });
    return NextResponse.json(
      {
        error: 'prep notes not yet generated',
        detail: error?.message ?? 'no blob returned',
      },
      { status: 404 }
    );
  }

  // Convert Blob → Buffer → Response with correct Content-Type.
  // Cache-Control: private + no-store because (a) auth is per-user,
  // (b) regenerated content can change at any time when an operator
  // re-runs the cron with force_audit_id.
  const buffer = Buffer.from(await blob.arrayBuffer());
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      // X-Content-Type-Options: nosniff is good practice — prevents
      // browsers from second-guessing our declared Content-Type.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
