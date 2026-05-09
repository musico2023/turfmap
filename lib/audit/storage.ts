/**
 * Supabase Storage helpers for the `audit-roadmaps` bucket — the
 * persistent home for generated Roadmap PDFs + Strategist Prep
 * Notes markdown.
 *
 * Layout: `<audit_id>/roadmap.pdf` and `<audit_id>/prep-notes.md`.
 * Both are private; access is via signed URLs (90-day expiry) we
 * mint at email-send time. The audit_id namespace gives us a clean
 * cascade — when an audit row is deleted, we can list+delete the
 * folder in one call.
 *
 * Phase 3 callers:
 *   - /api/cron/audit-milestones (24h-pre-call generation)
 *   - /api/audit/[id]/regenerate-pdf (operator-triggered re-mint
 *     when the AI prompt rev's)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export const AUDIT_ROADMAPS_BUCKET = 'audit-roadmaps';

/** Default signed-URL expiry for buyer + operator delivery links.
 *  90 days lines up with the Roadmap's lifespan; if the buyer needs
 *  it after that we re-mint via the operator dashboard. */
export const SIGNED_URL_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Upload a Roadmap PDF for an audit. Overwrites on conflict so a
 *  regeneration is a single call. */
export async function uploadRoadmapPdf(
  supabase: SupabaseLike,
  args: { auditId: string; pdfBuffer: Buffer }
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const path = `${args.auditId}/roadmap.pdf`;
  const { error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .upload(path, new Uint8Array(args.pdfBuffer), {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (error) {
    console.error('[audit-roadmaps] PDF upload failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true, path };
}

/** Upload Strategist Prep Notes (markdown). Same overwrite semantics
 *  as the PDF — re-running the cron stamps a fresh version. */
export async function uploadPrepNotes(
  supabase: SupabaseLike,
  args: { auditId: string; markdown: string }
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const path = `${args.auditId}/prep-notes.md`;
  const { error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .upload(path, new Blob([args.markdown], { type: 'text/markdown' }), {
      contentType: 'text/markdown',
      upsert: true,
    });
  if (error) {
    console.error('[audit-roadmaps] prep-notes upload failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true, path };
}

/** Mint a signed URL for an audit-roadmaps file. Used right before
 *  email send so the link in the buyer's inbox is fresh — TTL clock
 *  starts at mint, not at upload, so a 90-day signed URL means the
 *  buyer has 90 days from delivery, not 90 days from generation. */
export async function signedUrlForAuditFile(
  supabase: SupabaseLike,
  path: string,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) {
    console.error('[audit-roadmaps] signed-url mint failed', error);
    return { ok: false, error: error?.message ?? 'no signed URL returned' };
  }
  return { ok: true, url: data.signedUrl };
}

/** One-shot helper: upload a freshly-rendered PDF + prep-notes pair
 *  and return signed URLs for both. Used by the milestone cron's
 *  pre-call branch where we always do all four operations together. */
export async function uploadAuditArtifacts(
  supabase: SupabaseLike,
  args: { auditId: string; pdfBuffer: Buffer; prepMarkdown: string }
): Promise<
  | {
      ok: true;
      roadmapUrl: string;
      prepNotesUrl: string;
    }
  | { ok: false; stage: 'pdf' | 'prep' | 'sign-pdf' | 'sign-prep'; error: string }
> {
  const pdfUp = await uploadRoadmapPdf(supabase, args);
  if (!pdfUp.ok) return { ok: false, stage: 'pdf', error: pdfUp.error };

  const prepUp = await uploadPrepNotes(supabase, {
    auditId: args.auditId,
    markdown: args.prepMarkdown,
  });
  if (!prepUp.ok) return { ok: false, stage: 'prep', error: prepUp.error };

  const pdfSigned = await signedUrlForAuditFile(supabase, pdfUp.path);
  if (!pdfSigned.ok)
    return { ok: false, stage: 'sign-pdf', error: pdfSigned.error };

  const prepSigned = await signedUrlForAuditFile(supabase, prepUp.path);
  if (!prepSigned.ok)
    return { ok: false, stage: 'sign-prep', error: prepSigned.error };

  return {
    ok: true,
    roadmapUrl: pdfSigned.url,
    prepNotesUrl: prepSigned.url,
  };
}
