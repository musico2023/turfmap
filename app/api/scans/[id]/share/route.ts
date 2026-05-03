/**
 * POST   /api/scans/[id]/share — create a new public share link.
 * GET    /api/scans/[id]/share — list existing share links for this scan.
 *
 * Both routes are agency-gated. The DELETE counterpart lives at
 * /api/share/[shareId] because the share link's natural URL is keyed
 * by share-link-id, not scan-id (you might want to revoke a link
 * without knowing/remembering which scan it belonged to).
 *
 * POST body:
 *   {
 *     daysToExpire?: number,    // default 30, max 365
 *     agencyLabel?: string,     // shown on the public view as "Shared by …"
 *     ctaText?: string,         // bottom-of-page CTA, e.g. "Talk to us"
 *     ctaUrl?: string,          // CTA target URL
 *   }
 *
 * Response: { id, url, expiresAt }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import type { ScanShareLinkRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

const PostBody = z.object({
  daysToExpire: z.number().int().min(1).max(365).optional(),
  agencyLabel: z.string().max(200).optional().nullable(),
  ctaText: z.string().max(120).optional().nullable(),
  ctaUrl: z.string().url().max(500).optional().nullable(),
});

const DEFAULT_DAYS = 30;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: scanId } = await params;

  let parsed: z.infer<typeof PostBody>;
  try {
    parsed = PostBody.parse(await req.json().catch(() => ({})));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();

  // Confirm the scan exists + is complete (no point sharing in-progress
  // or failed scans).
  const { data: scan } = await supabase
    .from('scans')
    .select('id, status')
    .eq('id', scanId)
    .maybeSingle<{ id: string; status: string | null }>();
  if (!scan) {
    return NextResponse.json({ error: 'scan not found' }, { status: 404 });
  }
  if (scan.status !== 'complete') {
    return NextResponse.json(
      { error: `scan status is "${scan.status}" — only complete scans can be shared` },
      { status: 409 }
    );
  }

  const days = parsed.daysToExpire ?? DEFAULT_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const { data: link, error } = await supabase
    .from('scan_share_links')
    .insert({
      scan_id: scanId,
      created_by: auth.id,
      expires_at: expiresAt.toISOString(),
      agency_label: parsed.agencyLabel ?? null,
      cta_text: parsed.ctaText ?? null,
      cta_url: parsed.ctaUrl ?? null,
    })
    .select('*')
    .single<ScanShareLinkRow>();
  if (error || !link) {
    return NextResponse.json(
      { error: `share link create failed: ${error?.message ?? 'no row'}` },
      { status: 500 }
    );
  }

  // Build the public URL using the request's origin so dev/staging/prod
  // all produce correct URLs without env config.
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  return NextResponse.json({
    id: link.id,
    url: `${origin}/share/${link.id}`,
    expiresAt: link.expires_at,
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: scanId } = await params;

  const supabase = getServerSupabase();
  const { data: links, error } = await supabase
    .from('scan_share_links')
    .select('*')
    .eq('scan_id', scanId)
    .order('created_at', { ascending: false })
    .returns<ScanShareLinkRow[]>();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  return NextResponse.json({
    links: (links ?? []).map((l) => ({
      id: l.id,
      createdAt: l.created_at,
      expiresAt: l.expires_at,
      revokedAt: l.revoked_at,
      viewCount: l.view_count ?? 0,
      lastViewedAt: l.last_viewed_at,
      agencyLabel: l.agency_label,
      ctaText: l.cta_text,
      ctaUrl: l.cta_url,
      status: l.revoked_at
        ? 'revoked'
        : new Date(l.expires_at).getTime() < now
          ? 'expired'
          : 'active',
    })),
  });
}
