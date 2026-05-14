/**
 * POST /api/citations/photos — upload a single citation profile photo.
 *
 * Operators uploading on behalf of clients aren't expected to have
 * publicly-hostable image URLs ready, so the citation onboarding form
 * uploads files through this endpoint and stores the resulting public
 * URL in the form state. On submit, the URL is persisted into
 * citation_orders.submitted_profile.photo_urls alongside the other
 * BL-bound fields.
 *
 * Storage layout:
 *   citation-photos/<client_id>/<location_id>/<timestamp>-<rand>.<ext>
 *
 * Public bucket. Service-role upload (no insert policies) so the
 * anon key can't write to it directly. The bucket is created on
 * first use if it doesn't already exist.
 *
 * Pre-submit photos that the operator never references via a
 * citation_orders submission become orphans — same trade-off the
 * pre-uploader URL flow had. A future cleanup cron can prune
 * citation-photos/* objects older than N days that aren't referenced
 * by any submitted_profile.photo_urls.
 *
 * POST body: multipart/form-data with `file` + `client_id` +
 *            `location_id` (both UUIDs).
 * Returns:   { url } on success, { error } on failure.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';
export const maxDuration = 30;

const BUCKET = 'citation-photos';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per photo
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

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
  const clientId = formData.get('client_id');
  const locationId = formData.get('location_id');

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'missing `file` field' },
      { status: 400 }
    );
  }
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return NextResponse.json(
      { error: 'missing or invalid `client_id`' },
      { status: 400 }
    );
  }
  if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) {
    return NextResponse.json(
      { error: 'missing or invalid `location_id`' },
      { status: 400 }
    );
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      {
        error: `unsupported file type: ${file.type || 'unknown'} (allowed: png, jpg, webp)`,
      },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `file is too large (${(file.size / 1024 / 1024).toFixed(2)} MB; max 5 MB)`,
      },
      { status: 413 }
    );
  }

  const supabase = getServerSupabase();

  // Ensure the bucket exists. Idempotent: if it's already there, the
  // create call returns an error we can swallow. Cheap one-time setup.
  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: MAX_BYTES,
    allowedMimeTypes: Array.from(ALLOWED_MIME),
  });
  if (bucketErr && !/already exists/i.test(bucketErr.message)) {
    return NextResponse.json(
      { error: `bucket setup failed: ${bucketErr.message}` },
      { status: 500 }
    );
  }

  const ext = EXT_FOR_MIME[file.type] ?? 'bin';
  const key = `${clientId}/${locationId}/${Date.now()}-${randomToken(6)}.${ext}`;

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

  return NextResponse.json({ url: publicUrl });
}

function randomToken(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
