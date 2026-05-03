'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  Link2,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Agency-side "Share" button. Opens a modal showing existing share
 * links for this scan + a form to create new ones. Renders next to
 * the PDF / Re-scan buttons in the dashboard header row.
 *
 * Hits three API routes:
 *   POST   /api/scans/<id>/share   → create
 *   GET    /api/scans/<id>/share   → list
 *   DELETE /api/share/<linkId>     → revoke
 */

type ShareLink = {
  id: string;
  createdAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  agencyLabel: string | null;
  ctaText: string | null;
  ctaUrl: string | null;
  status: 'active' | 'expired' | 'revoked';
};

const EXPIRY_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' },
];

export function ShareLinkButton({ scanId }: { scanId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-2 rounded-md text-xs font-bold border transition-colors flex items-center gap-1.5 hover:border-zinc-700"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <Link2 size={12} /> Share
      </button>
      {open && <ShareModal scanId={scanId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareModal({
  scanId,
  onClose,
}: {
  scanId: string;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [agencyLabel, setAgencyLabel] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Initial load — fetch existing links.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}/share`);
        const data = (await res.json()) as
          | { links: ShareLink[] }
          | { error: string };
        if (cancelled) return;
        if ('error' in data) {
          setLoadError(data.error);
        } else {
          setLinks(data.links);
        }
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/scans/${scanId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          daysToExpire: days,
          agencyLabel: agencyLabel.trim() || undefined,
          ctaText: ctaText.trim() || undefined,
          ctaUrl: ctaUrl.trim() || undefined,
        }),
      });
      const data = (await res.json()) as
        | { id: string; url: string; expiresAt: string }
        | { error: string };
      if ('error' in data) {
        setCreateError(data.error);
        return;
      }
      // Reload the list so the new link appears.
      const listRes = await fetch(`/api/scans/${scanId}/share`);
      const listData = (await listRes.json()) as { links: ShareLink[] };
      setLinks(listData.links);
      // Auto-copy the just-created URL.
      navigator.clipboard.writeText(data.url).catch(() => {});
      setCopiedId(data.id);
      setTimeout(() => setCopiedId((c) => (c === data.id ? null : c)), 2000);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onRevoke = async (linkId: string) => {
    if (!confirm('Revoke this link? The recipient will no longer be able to view the scan.')) return;
    try {
      const res = await fetch(`/api/share/${linkId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(data.error ?? 'revoke failed');
        return;
      }
      // Refresh.
      const listRes = await fetch(`/api/scans/${scanId}/share`);
      const listData = (await listRes.json()) as { links: ShareLink[] };
      setLinks(listData.links);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const onCopy = (linkId: string) => {
    const url = `${window.location.origin}/share/${linkId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedId(linkId);
    setTimeout(() => setCopiedId((c) => (c === linkId ? null : c)), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 py-12 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <Link2 size={16} style={{ color: 'var(--color-lime)' }} />
            <h3 className="font-display text-lg font-bold">Share this scan</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>

        {/* Create new form */}
        <form
          onSubmit={onCreate}
          className="px-5 py-4 border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            Generate a public read-only link to this scan. No signup
            required for the recipient. Auto-expires; revocable any time.
          </div>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="px-2 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-xs text-zinc-200"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Expires in {o.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={submitting}
              className="ml-auto px-4 py-2 rounded-md font-bold text-xs flex items-center gap-1.5 transition-all hover:brightness-110 disabled:opacity-50"
              style={{
                background: 'var(--color-lime)',
                color: 'black',
              }}
            >
              {submitting ? (
                <Activity size={11} className="animate-pulse" />
              ) : (
                <Link2 size={11} strokeWidth={2.5} />
              )}
              Create link
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-3 text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
          >
            {showAdvanced ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {showAdvanced ? 'Hide' : 'Customize'} branding + CTA
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-2">
              <input
                type="text"
                value={agencyLabel}
                onChange={(e) => setAgencyLabel(e.target.value)}
                placeholder='"Shared by" label (default: Fourdots Digital)'
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-xs text-zinc-200 placeholder-zinc-600"
              />
              <input
                type="text"
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                placeholder='CTA headline (default: "Want a TurfMap of your business?")'
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-xs text-zinc-200 placeholder-zinc-600"
              />
              <input
                type="url"
                value={ctaUrl}
                onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="CTA URL (default: fourdots.io)"
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-xs text-zinc-200 placeholder-zinc-600 font-mono"
              />
            </div>
          )}

          {createError && (
            <div className="text-[11px] text-red-400 font-mono mt-2">
              {createError}
            </div>
          )}
        </form>

        {/* Existing links */}
        <div className="px-5 py-4 max-h-96 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-3">
            Existing links
          </div>
          {loadError && (
            <div className="text-[11px] text-red-400 font-mono">{loadError}</div>
          )}
          {!loadError && links === null && (
            <div className="text-xs text-zinc-500 italic">Loading…</div>
          )}
          {links !== null && links.length === 0 && (
            <div className="text-xs text-zinc-600 italic">
              No share links yet. Create one above.
            </div>
          )}
          {links !== null && links.length > 0 && (
            <div className="space-y-2">
              {links.map((l) => (
                <LinkRow
                  key={l.id}
                  link={l}
                  copied={copiedId === l.id}
                  onCopy={() => onCopy(l.id)}
                  onRevoke={() => onRevoke(l.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkRow({
  link,
  copied,
  onCopy,
  onRevoke,
}: {
  link: ShareLink;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  // Render the FULL URL (protocol + host + path) inside the readonly
  // input below so a user who manually selects + copies the displayed
  // string gets a paste-safe URL, not just `/share/<id>` which would be
  // a broken relative link in the recipient's email/Slack/whatever.
  // window.location.origin is browser-only — start with a server-safe
  // fallback and hydrate after mount to avoid SSR mismatch warnings.
  const [shareUrl, setShareUrl] = useState(`/share/${link.id}`);
  useEffect(() => {
    setShareUrl(`${window.location.origin}/share/${link.id}`);
  }, [link.id]);

  const expires = new Date(link.expiresAt);
  const expiresLabel =
    link.status === 'expired'
      ? `Expired ${expires.toISOString().slice(0, 10)}`
      : link.status === 'revoked'
        ? `Revoked ${link.revokedAt ? new Date(link.revokedAt).toISOString().slice(0, 10) : ''}`
        : `Expires ${expires.toISOString().slice(0, 10)}`;
  const statusColor =
    link.status === 'active'
      ? 'var(--color-lime)'
      : link.status === 'expired'
        ? '#a1a1aa'
        : '#ff4d4d';

  return (
    <div
      className="border rounded-md px-3 py-2.5"
      style={{
        background: 'var(--color-bg)',
        borderColor: 'var(--color-border)',
        opacity: link.status === 'active' ? 1 : 0.55,
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded"
          style={{
            background: '#0d130a',
            color: statusColor,
            border: `1px solid ${statusColor}40`,
          }}
        >
          {link.status}
        </span>
        <span className="text-[11px] text-zinc-500 font-mono">{expiresLabel}</span>
        <span className="ml-auto text-[11px] text-zinc-500 flex items-center gap-1">
          <Eye size={11} /> {link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}
        </span>
      </div>
      {/* URL row.
       *  - Read-only <input> (not <code>) so triple-click selects the full
       *    string — and we put the FULL URL in there so any manual copy
       *    yields a working paste, not a bare path.
       *  - Click-to-select on focus (operators sometimes do that instead
       *    of clicking the dedicated Copy button — make their muscle
       *    memory work).
       *  - The Copy button is the primary CTA: lime, labeled, sized to
       *    match the input. Pre-bump it was a small zinc icon and people
       *    were defaulting to triple-clicking the path string. */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
          className="flex-1 px-2.5 py-1.5 rounded-md border bg-[var(--color-card)] border-[var(--color-border)] text-[11px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-600 transition-colors"
          aria-label="Share URL"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onCopy}
          disabled={link.status !== 'active'}
          leftIcon={
            copied ? <Check size={11} strokeWidth={2.75} /> : <Copy size={11} strokeWidth={2.5} />
          }
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        {link.status === 'active' && (
          <button
            type="button"
            onClick={onRevoke}
            title="Revoke"
            className="text-zinc-500 hover:text-red-400 transition-colors p-1.5"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {link.lastViewedAt && link.viewCount > 0 && (
        <div className="text-[10px] text-zinc-600 mt-1.5 font-mono">
          Last viewed {new Date(link.lastViewedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
        </div>
      )}
    </div>
  );
}
