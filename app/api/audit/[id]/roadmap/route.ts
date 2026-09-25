/**
 * GET /api/audit/[id]/roadmap
 *
 * Serves the Roadmap PDF for an audit, streamed from Supabase Storage
 * through our own origin.
 *
 * Why this exists: the Roadmap was delivered as a 90-day signed Storage
 * URL persisted on `visibility_audits.roadmap_pdf_url`, and nothing ever
 * re-signed it. Every stored link had therefore lapsed — all three live
 * audits were serving expired URLs (by 2, 9 and 29 days) from the agency
 * dashboard AND from the 60-day milestone email, so paying buyers were
 * clicking a dead link for the $499 deliverable (found 2026-09-24).
 *
 * A stable route fixes the class of bug, not just the instances: the link
 * in an email sent today still resolves next year, because the signature
 * is minted per request instead of being frozen into a column.
 *
 * Auth: the audit id is a bearer capability, deliberately — this is the
 * BUYER's deliverable and it has to open from an email with no sign-in.
 * That is the same trust model the emailed signed URL already had (anyone
 * holding the link could fetch the PDF), minus the expiry, and the id is
 * an unguessable v4 UUID. An agency session is accepted but not required.
 *
 * It is strictly tighter than what it replaces in two ways: the signed
 * URL used to be readable from `visibility_audits` (that cross-tenant RLS
 * leak is closed as of migration 0052), and access can now be revoked by
 * deleting the object, which a minted 90-day URL never allowed.
 *
 * If this should ever become portal-session-gated, the check belongs here
 * — the callers already point at a route rather than a raw URL.
 *
 *   200 application/pdf
 *   400 missing id
 *   404 audit or PDF not found (same body either way — a prober must not
 *       be able to tell an unknown id from an id with no PDF yet)
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { AUDIT_ROADMAPS_BUCKET } from '@/lib/audit/storage';
import type { VisibilityAuditRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const NOT_FOUND = { error: 'roadmap not found' };

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: auditId } = await ctx.params;
  if (!auditId) {
    return NextResponse.json({ error: 'audit id required' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('id')
    .eq('id', auditId)
    .maybeSingle<Pick<VisibilityAuditRow, 'id'>>();
  if (!audit) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  // Service-role download — no signed URL needed to read the bytes, which
  // is the whole point: nothing with an expiry gets persisted anywhere.
  const path = `${auditId}/roadmap.pdf`;
  const { data: blob, error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .download(path);
  if (error || !blob) {
    console.error('[audit/roadmap] Storage download failed', {
      auditId,
      path,
      error: error?.message,
    });
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      // inline so it opens in the browser's PDF viewer rather than
      // downloading as an opaque file from an email click.
      'Content-Disposition': 'inline; filename="turfmap-roadmap.pdf"',
      // The PDF is regenerated in place when an audit is re-run, and the
      // URL is a capability — don't let a shared cache hold either.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
