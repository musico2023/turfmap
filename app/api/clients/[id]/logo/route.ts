/**
 * POST   /api/clients/[id]/logo — upload a logo for a client.
 * DELETE /api/clients/[id]/logo — remove the current logo.
 *
 * Both routes are agency-gated. Uploads go to the public `client-logos`
 * bucket via service-role (no RLS policies on insert means anon-key
 * uploads are blocked even though the bucket is public-read).
 *
 * POST body: multipart/form-data with a single `file` field.
 * Returns:   { logo_url } on success, or { error } on failure.
 *
 * Storage layout: client-logos/<client_id>/<timestamp>-<rand>.<ext>
 * The client_id prefix scopes uploads per-client and lets a future
 * "purge all logos for client X" operation be a single prefix delete.
 *
 * On replacement, the previous logo (if any) is deleted from storage so
 * we don't accumulate orphaned files. Tracked by parsing the public URL
 * back to its bucket path.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { resolveClientUuid } from '@/lib/supabase/client-lookup';

export const runtime = 'nodejs';
export const maxDuration = 30;

const BUCKET = 'client-logos';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;
  const supabase = getServerSupabase();
  const id = await resolveClientUuid(supabase, clientParam);
  if (!id) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'expected multipart/form-data' },
      { status: 400 }
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'missing `file` field' },
      { status: 400 }
    );
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      {
        error: `unsupported file type: ${file.type || 'unknown'} (allowed: png, jpg, webp, svg)`,
      },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `file is too large (${(file.size / 1024 / 1024).toFixed(2)} MB; max 2 MB)`,
      },
      { status: 413 }
    );
  }

  // Confirm the client exists (and incidentally remember the previous
  // logo so we can clean it up after a successful upload).
  const { data: client } = await supabase
    .from('clients')
    .select('id, logo_url')
    .eq('id', id)
    .maybeSingle<{ id: string; logo_url: string | null }>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const ext = EXT_FOR_MIME[file.type] ?? 'bin';
  const key = `${id}/${Date.now()}-${randomToken(6)}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(key, new Uint8Array(arrayBuffer), {
      contentType: file.type,
      upsert: false,
    });
  if (uploadErr) {
    return NextResponse.json(
      { error: `upload failed: ${uploadErr.message}` },
      { status: 502 }
    );
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(key);

  // Persist the new URL; if this fails, fall back by removing the just-
  // uploaded object so we don't strand orphans.
  const { error: updateErr } = await supabase
    .from('clients')
    .update({ logo_url: publicUrl })
    .eq('id', id);
  if (updateErr) {
    await supabase.storage.from(BUCKET).remove([key]);
    return NextResponse.json(
      { error: `failed to update client: ${updateErr.message}` },
      { status: 500 }
    );
  }

  // Best-effort cleanup of the previous logo. Don't fail the request if
  // this doesn't work — the new logo is already live and persisted.
  if (client.logo_url) {
    const oldKey = bucketKeyFromPublicUrl(client.logo_url, BUCKET);
    if (oldKey) {
      await supabase.storage.from(BUCKET).remove([oldKey]);
    }
  }

  return NextResponse.json({ logo_url: publicUrl });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { id: clientParam } = await params;
  const supabase = getServerSupabase();
  const id = await resolveClientUuid(supabase, clientParam);
  if (!id) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const { data: client } = await supabase
    .from('clients')
    .select('id, logo_url')
    .eq('id', id)
    .maybeSingle<{ id: string; logo_url: string | null }>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  if (client.logo_url) {
    const oldKey = bucketKeyFromPublicUrl(client.logo_url, BUCKET);
    if (oldKey) {
      // Best-effort — even if storage remove fails we still null out the
      // column so the UI stops trying to render it.
      await supabase.storage.from(BUCKET).remove([oldKey]);
    }
  }

  const { error: updateErr } = await supabase
    .from('clients')
    .update({ logo_url: null })
    .eq('id', id);
  if (updateErr) {
    return NextResponse.json(
      { error: `failed to clear logo_url: ${updateErr.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}

function randomToken(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Public URLs from Supabase Storage look like:
 *   https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<key>
 * Reverses that back to <key> so we can delete the previous file.
 * Returns null for any URL we don't recognize (manually-set hotlinks
 * from the pre-uploader era — those just stay where they are).
 */
function bucketKeyFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length);
}
