'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Check, Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type ClientUserRow = {
  id: string;
  client_id: string;
  email: string;
  invited_at: string | null;
  last_login_at: string | null;
};

export type ClientUsersManagerProps = {
  /** Canonical client UUID. Used as `client_id` in the agency API
   *  (POST /api/client_users). The settings page passes `client.id`. */
  clientId: string;
  /** Public-id slug used to construct the portal sign-in URL the
   *  operator hands to the invitee. Exposed separately because the
   *  agency API keys off UUID but the URL the user visits should be
   *  the short slug. */
  clientPublicId: string;
  users: ClientUserRow[];
};

const PORTAL_USERS_PER_CLIENT = 5;

export function ClientUsersManager({
  clientId,
  clientPublicId,
  users,
}: ClientUsersManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);
  const [copiedAt, setCopiedAt] = useState<string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const atCap = users.length >= PORTAL_USERS_PER_CLIENT;

  const portalLoginUrl = (() => {
    if (typeof window === 'undefined') {
      // SSR pass — use a relative path so the URL is whatever the
      // current origin is at click time. The actual click only fires
      // client-side anyway; this branch is just to keep the component
      // happy during the server render.
      return `/portal/${clientPublicId}/login`;
    }
    return `${window.location.origin}/portal/${clientPublicId}/login`;
  })();

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!newEmail.trim()) return;
    setBusy('add');
    try {
      const res = await fetch('/api/client_users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          email: newEmail.trim(),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      const added = newEmail.trim().toLowerCase();
      setNewEmail('');
      setNotice(
        `${added} can now access the portal. Copy the sign-in link below and share it with them — they'll request a magic link from there.`
      );
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onCopyLink = async (rowId: string) => {
    setError(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(portalLoginUrl);
      setCopiedAt(rowId);
      // Auto-clear the "copied" pill after a beat so the icon flips
      // back. Two seconds is long enough to register, short enough to
      // not feel sticky.
      setTimeout(
        () => setCopiedAt((curr) => (curr === rowId ? null : curr)),
        2000
      );
    } catch (e) {
      setError(
        `clipboard write failed — copy this URL manually: ${portalLoginUrl}`
      );
      // Surface the underlying error too in case it's something other
      // than a permissions denial.
      console.warn('clipboard write failed:', e);
    }
  };

  const onCopyShared = async () => {
    setError(null);
    setNotice(null);
    try {
      await navigator.clipboard.writeText(portalLoginUrl);
      setCopiedAt('__shared__');
      setTimeout(
        () => setCopiedAt((curr) => (curr === '__shared__' ? null : curr)),
        2000
      );
    } catch (e) {
      setError(
        `clipboard write failed — copy this URL manually: ${portalLoginUrl}`
      );
      console.warn('clipboard write failed:', e);
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
    setNotice(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/client_users/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `delete failed (HTTP ${res.status})`);
        return;
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      id="portal-users"
      className="border rounded-lg p-5 scroll-mt-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">Portal users</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Adding an email grants portal access. Copy the sign-in
            link below and share it with the user — they request a
            magic link from there. Up to {PORTAL_USERS_PER_CLIENT}{' '}
            users per client.
          </p>
        </div>
        <span
          className="text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded font-mono whitespace-nowrap"
          style={{
            background: atCap ? '#1a1308' : 'var(--color-bg)',
            color: atCap ? '#f5b651' : '#a1a1aa',
            border: `1px solid ${atCap ? '#3a2a0a' : 'var(--color-border)'}`,
          }}
        >
          {users.length} / {PORTAL_USERS_PER_CLIENT}
        </span>
      </div>

      {/* Shared portal sign-in URL — same for every user on this client.
          Big enough to read, with a one-click copy button so the
          operator can paste it into Slack/email without selecting and
          copying manually. */}
      <div
        className="mb-5 px-3 py-2.5 rounded-md border flex items-center gap-3"
        style={{
          background: 'var(--color-bg)',
          borderColor: 'var(--color-border)',
        }}
      >
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold whitespace-nowrap">
          Sign-in link
        </span>
        <span className="font-mono text-xs text-zinc-300 truncate flex-1">
          {portalLoginUrl}
        </span>
        <button
          type="button"
          onClick={onCopyShared}
          className="text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1.5 text-xs font-mono whitespace-nowrap"
          title="Copy portal sign-in link"
        >
          {copiedAt === '__shared__' ? (
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

      <div className="space-y-2 mb-5">
        {users.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No portal users yet. Add an email below to grant access,
            then share the sign-in link with them.
          </div>
        ) : (
          users.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md border"
              style={{
                background: 'var(--color-bg)',
                borderColor: 'var(--color-border)',
              }}
            >
              <span className="font-mono text-sm text-zinc-100 flex-1 truncate">
                {u.email}
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                {u.last_login_at
                  ? `last seen ${new Date(u.last_login_at).toISOString().slice(0, 10)}`
                  : u.invited_at
                    ? `invited ${new Date(u.invited_at).toISOString().slice(0, 10)}`
                    : 'not signed in yet'}
              </span>
              <button
                type="button"
                onClick={() => onCopyLink(u.id)}
                title="Copy portal sign-in link to share with this user"
                className="text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                {copiedAt === u.id ? (
                  <Check size={14} style={{ color: 'var(--color-lime)' }} />
                ) : (
                  <Copy size={14} />
                )}
              </button>
              <button
                type="button"
                onClick={() => onDelete(u.id)}
                disabled={busy === u.id}
                title="Revoke access"
                className="text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {busy === u.id ? (
                  <Activity size={14} className="animate-pulse" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))
        )}
      </div>

      <form onSubmit={onAdd} className="grid grid-cols-12 gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={
            atCap
              ? 'remove a user before adding another'
              : 'add a portal user (e.g. owner@client.com)'
          }
          disabled={atCap}
          className="col-span-10 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!newEmail.trim() || atCap}
          loading={busy === 'add'}
          leftIcon={<Plus size={12} strokeWidth={2.75} />}
          className="col-span-2"
        >
          Add
        </Button>
      </form>
      {error && (
        <div className="text-xs text-red-400 font-mono mt-3">{error}</div>
      )}
      {!error && notice && (
        <div className="text-xs font-mono mt-3" style={{ color: 'var(--color-lime)' }}>
          ✓ {notice}
        </div>
      )}
    </div>
  );
}
