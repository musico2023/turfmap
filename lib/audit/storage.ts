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
import { marked } from 'marked';

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

/** Upload Strategist Prep Notes — renders the source markdown into
 *  a styled HTML document and uploads as `.html`, since browsers
 *  display raw `.md` as plain text and operators were squinting at
 *  un-rendered `#` and `**` tokens. The HTML wraps the converted
 *  body in a TurfMap dark-themed shell so the page reads like a
 *  proper deliverable when Anthony opens the signed URL.
 *
 *  Same overwrite semantics as the PDF — re-running the cron stamps
 *  a fresh version. We do NOT also keep the raw markdown file; the
 *  HTML is the canonical artifact. The source markdown is still
 *  generated upstream by lib/ai/strategistPrep.ts and is what the
 *  AI returns; we just render before persistence.
 */
export async function uploadPrepNotes(
  supabase: SupabaseLike,
  args: { auditId: string; markdown: string }
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const html = renderPrepNotesHtml(args.markdown);
  const path = `${args.auditId}/prep-notes.html`;
  // Upload as a UTF-8 Buffer rather than a Blob. The Blob path was
  // resulting in the served file getting a generic content-type
  // (text/plain or octet-stream) regardless of the explicit
  // `contentType` option, which made the browser render the HTML as
  // raw source code instead of a styled page. The Buffer pattern
  // matches what we use for the PDF upload and produces a reliable
  // Content-Type: text/html; charset=utf-8 in the response headers.
  const { error } = await supabase.storage
    .from(AUDIT_ROADMAPS_BUCKET)
    .upload(path, Buffer.from(html, 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      upsert: true,
    });
  if (error) {
    console.error('[audit-roadmaps] prep-notes upload failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true, path };
}

/**
 * Wrap the AI-generated prep-notes markdown in a styled HTML
 * document. Visual treatment matches the rest of the TurfMap
 * product surface — dark background, lime accents, system-mono for
 * fact strips, display-font headings.
 *
 * Inlined CSS rather than a stylesheet link because Supabase Storage
 * serves these as standalone files; there's nowhere to host a
 * companion .css. Document is self-contained.
 */
function renderPrepNotesHtml(markdownSource: string): string {
  // Marked v18+ accepts a synchronous parse with default options.
  // Sanitize-by-default isn't needed here because the markdown is
  // generated server-side by our own AI prompt — no untrusted user
  // input flows into this string.
  const body = marked.parse(markdownSource, {
    gfm: true,
    breaks: false,
  }) as string;

  // Dark theme matching globals.css. Fonts are intentionally a
  // pragmatic fallback chain: a lot of mail clients / browser
  // previews lack our brand fonts, so we lead with Bricolage if
  // available + cascade to Inter / system-ui.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strategist Prep Notes</title>
<style>
  :root {
    --bg: #0a0a0a;
    --card: #0d0d0d;
    --card-glow: #0f1208;
    --border: #27272a;
    --border-bright: #2d3a14;
    --lime: #c5ff3a;
    --warn: #ff9f3a;
    --text: #ededed;
    --text-dim: #a1a1aa;
    --text-muted: #71717a;
    --text-faint: #52525b;
  }
  * { box-sizing: border-box; }
  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.6;
    margin: 0;
    padding: 0;
  }
  body { padding: 48px 24px 96px; }
  .container { max-width: 760px; margin: 0 auto; }
  h1 {
    font-family: 'Bricolage Grotesque', 'Inter', system-ui, sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 12px;
    letter-spacing: -0.01em;
  }
  h2 {
    font-family: 'Bricolage Grotesque', 'Inter', system-ui, sans-serif;
    font-size: 16px;
    font-weight: 700;
    color: var(--lime);
    margin: 32px 0 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  h3 {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
    margin: 20px 0 8px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  p {
    color: var(--text-dim);
    margin: 0 0 16px;
  }
  strong {
    color: var(--text);
    font-weight: 600;
  }
  em { color: var(--text-dim); }
  ul, ol {
    color: var(--text-dim);
    padding-left: 24px;
    margin: 0 0 16px;
  }
  li { margin: 6px 0; }
  li > strong { color: var(--text); }
  blockquote {
    border-left: 3px solid var(--lime);
    background: var(--card-glow);
    margin: 16px 0;
    padding: 12px 18px;
    color: var(--text);
    font-style: italic;
  }
  blockquote p:last-child { margin-bottom: 0; }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 32px 0;
  }
  code {
    font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
    font-size: 0.9em;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    color: var(--text-dim);
  }
  pre {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px;
    overflow-x: auto;
  }
  pre code {
    border: none;
    padding: 0;
    background: transparent;
  }
  a {
    color: var(--lime);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  a:hover { text-decoration-thickness: 2px; }
  /* Operator-affordance: small text at top noting where this came from */
  .footer-meta {
    margin-top: 64px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
    text-align: center;
  }
</style>
</head>
<body>
<div class="container">
${body}
<div class="footer-meta">TurfMap™ Strategist Prep Notes — operator-only</div>
</div>
</body>
</html>`;
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
