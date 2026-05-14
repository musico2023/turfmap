'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Download, Key, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Pulse+ data-export card.
 *
 * Two surfaces:
 *   1. Direct CSV download — link to /api/exports/csv with the
 *      operator's agency cookie. Hits a fresh export every click.
 *   2. Looker Studio + Google Sheets URL — exposes the public,
 *      token-gated /api/exports/looker endpoint. Operator pastes
 *      the URL into Looker (community connector) or into a Sheets
 *      =IMPORTDATA() formula. Generate / revoke buttons here flip
 *      the token on the clients row.
 */
export function ExportsCard({
  clientId,
  clientPublicId,
  initialLookerToken,
  appOrigin,
}: {
  clientId: string;
  clientPublicId: string;
  initialLookerToken: string | null;
  /** App origin (https://turfmap.ai in prod). Used to build the
   *  absolute Looker URL the operator copies. */
  appOrigin: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [token, setToken] = useState<string | null>(initialLookerToken);
  const [busy, setBusy] = useState<'gen' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lookerUrl = token
    ? `${appOrigin}/api/exports/looker?token=${token}`
    : null;
  const csvUrl = `/api/exports/csv?client_id=${clientId}`;

  const onGenerate = async () => {
    setError(null);
    setBusy('gen');
    try {
      const res = await fetch(`/api/clients/${clientPublicId}/looker-token`, {
        method: 'POST',
      });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      setToken(data.token);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRevoke = async () => {
    setError(null);
    setBusy('revoke');
    try {
      const res = await fetch(`/api/clients/${clientPublicId}/looker-token`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? `revoke failed (HTTP ${res.status})`);
        return;
      }
      setToken(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onCopy = async () => {
    if (!lookerUrl) return;
    try {
      await navigator.clipboard.writeText(lookerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(`clipboard write failed — copy manually: ${lookerUrl}`);
      console.warn('clipboard write failed:', e);
    }
  };

  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4 flex items-start gap-3">
        <Download
          size={16}
          className="flex-shrink-0 mt-0.5"
          style={{ color: 'var(--color-lime)' }}
        />
        <div>
          <h3 className="font-display text-lg font-bold">Data exports</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Pull this client&rsquo;s scan history into spreadsheets, BI
            tools, or your own pipeline. CSV downloads instantly.
            Looker Studio + Google Sheets connect via the
            token-protected URL below.
          </p>
        </div>
      </div>

      {/* CSV download */}
      <div
        className="rounded-md border px-3 py-3 mb-4 flex items-center gap-3"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold whitespace-nowrap">
          CSV
        </span>
        <span className="text-xs text-zinc-400 flex-1 leading-snug">
          One row per (scan × cell). All scans, all locations.
        </span>
        <a
          href={csvUrl}
          download
          className="text-xs font-bold px-3 py-1.5 rounded transition-all hover:brightness-110 inline-flex items-center gap-1.5"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
          }}
        >
          <Download size={11} /> Download
        </a>
      </div>

      {/* Looker / Sheets URL */}
      <div
        className="rounded-md border px-3 py-3"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center gap-2 mb-2">
          <Key size={11} className="text-zinc-500" />
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Looker Studio + Google Sheets
          </span>
        </div>
        {token && lookerUrl ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-xs text-zinc-300 truncate flex-1">
                {lookerUrl}
              </span>
              <button
                type="button"
                onClick={onCopy}
                className="text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1.5 text-xs font-mono whitespace-nowrap"
                title="Copy URL"
              >
                {copied ? (
                  <>
                    <Check size={12} style={{ color: 'var(--color-lime)' }} />
                    <span style={{ color: 'var(--color-lime)' }}>copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={12} /> copy
                  </>
                )}
              </button>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed mb-3">
              In Looker Studio: Add data → JSON Connector (community)
              → paste this URL. In Sheets: paste{' '}
              <span className="font-mono text-zinc-400">
                =IMPORTDATA(&quot;{appOrigin}/api/exports/csv?client_id=
                {clientId}&quot;)
              </span>{' '}
              for CSV (or use this Looker URL with a JSON connector).
              Anyone with this URL can read this client&rsquo;s scan
              data — treat it like an API key.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                onClick={onGenerate}
                disabled={busy !== null}
                loading={busy === 'gen'}
                leftIcon={<RefreshCw size={11} />}
              >
                Regenerate
              </Button>
              <Button
                variant="destructive"
                size="md"
                onClick={onRevoke}
                disabled={busy !== null}
                loading={busy === 'revoke'}
                leftIcon={<Trash2 size={11} />}
              >
                Revoke
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-zinc-500 leading-relaxed mb-3">
              No token issued yet. Generate one to expose this client&rsquo;s
              scan history at a public, token-gated URL.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={onGenerate}
              disabled={busy !== null}
              loading={busy === 'gen'}
              leftIcon={<Key size={11} />}
            >
              Generate token
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 font-mono mt-3">{error}</div>
      )}
    </div>
  );
}
