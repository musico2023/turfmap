'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Logo uploader for the client settings page.
 *
 * Works independently of the surrounding settings <form> — uploads/removals
 * commit immediately to the server (multipart POST / DELETE on
 * `/api/clients/<id>/logo`) and then router.refresh()es the page so the new
 * URL flows through. Doesn't get caught up in the dirty-tracking logic of
 * the parent form.
 */
export function LogoUploader({
  clientId,
  initialLogoUrl,
  businessName,
  accent,
}: {
  clientId: string;
  initialLogoUrl: string | null;
  businessName: string;
  accent: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onPick = () => fileInputRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow picking the same file twice in a row
    setError(null);
    setBusy('uploading');

    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`/api/clients/${clientId}/logo`, {
        method: 'POST',
        body: fd,
      });
      const data = (await res.json()) as { logo_url?: string; error?: string };
      if (!res.ok || !data.logo_url) {
        setError(data.error ?? `upload failed (HTTP ${res.status})`);
        return;
      }
      setLogoUrl(data.logo_url);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    setError(null);
    setBusy('removing');
    try {
      const res = await fetch(`/api/clients/${clientId}/logo`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? `remove failed (HTTP ${res.status})`);
        return;
      }
      setLogoUrl(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const initial = (businessName.trim().charAt(0) || 'T').toUpperCase();

  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center justify-between">
        <span>Logo</span>
        <span className="text-[10px] normal-case tracking-normal text-zinc-600">
          square · ≥ 256×256 · PNG / JPG / WEBP / SVG · max 2 MB
        </span>
      </div>

      <div
        className="flex items-center gap-4 p-3 rounded-md border"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        {/* Preview — object-contain (not cover) so tall/wide logos
            display in full instead of getting cropped. The container
            has a neutral bg + small padding so transparent PNGs show
            cleanly and aspect-mismatched logos don't kiss the edges. */}
        <div className="flex-shrink-0">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={businessName}
              className="w-16 h-16 rounded-md object-contain border p-1.5"
              style={{
                borderColor: 'var(--color-border)',
                background: '#0a0a0a',
                boxShadow: `0 0 24px ${accent}30`,
              }}
            />
          ) : (
            <div
              className="w-16 h-16 rounded-md flex items-center justify-center font-display font-bold text-2xl text-black"
              style={{
                background: accent,
                boxShadow: `0 0 24px ${accent}40`,
              }}
              title="No logo set — falls back to a letter mark in the brand accent"
            >
              {initial}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-zinc-400 mb-2 truncate">
            {logoUrl ? (
              <span className="font-mono text-zinc-500">
                {filenameFromUrl(logoUrl)}
              </span>
            ) : (
              <span className="text-zinc-500">
                No logo set — using a letter mark in the brand accent.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={onPick}
              disabled={busy !== null}
              loading={busy === 'uploading'}
              leftIcon={logoUrl ? <ImageIcon size={12} /> : <Upload size={12} />}
            >
              {logoUrl ? 'Replace' : 'Upload'}
            </Button>
            {logoUrl && (
              <Button
                variant="destructive"
                size="md"
                onClick={onRemove}
                disabled={busy !== null}
                loading={busy === 'removing'}
                leftIcon={<Trash2 size={12} />}
              >
                Remove
              </Button>
            )}
          </div>
          {error && (
            <div className="text-xs text-red-400 font-mono mt-2">{error}</div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={onFile}
        className="hidden"
      />
    </div>
  );
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    return last.length > 32 ? last.slice(0, 30) + '…' : last;
  } catch {
    return url;
  }
}
