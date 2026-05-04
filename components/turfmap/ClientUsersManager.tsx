'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Mail, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type ClientUserRow = {
  id: string;
  client_id: string;
  email: string;
  invited_at: string | null;
  last_login_at: string | null;
};

export type ClientUsersManagerProps = {
  /** Canonical client UUID. Used as `client_id` in both the agency
   *  API (POST /api/client_users) and the portal magic-link API
   *  (POST /api/auth/magic-link). The settings page passes
   *  `client.id` here — NOT the public-id slug — because both
   *  endpoints look up client_users by UUID. */
  clientId: string;
  users: ClientUserRow[];
};

/** Soft cap mirrored client-side from app/api/client_users/route.ts.
 *  The server enforces this; the UI just disables the form so the
 *  operator gets immediate feedback rather than waiting for a 400. */
const PORTAL_USERS_PER_CLIENT = 5;

export function ClientUsersManager({
  clientId,
  users,
}: ClientUsersManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const atCap = users.length >= PORTAL_USERS_PER_CLIENT;

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
      const data = (await res.json()) as {
        error?: string;
        invite_sent?: boolean;
        invite_error?: string | null;
      };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      const added = newEmail.trim().toLowerCase();
      setNewEmail('');
      if (data.invite_sent === false) {
        setNotice(
          `${added} added — but the invite email failed to send (${
            data.invite_error ?? 'unknown'
          }). Use Resend to retry.`
        );
      } else {
        setNotice(`Invite sent to ${added}.`);
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onResend = async (id: string, email: string) => {
    setError(null);
    setNotice(null);
    setBusy(`resend:${id}`);
    try {
      // Hits the public portal magic-link endpoint — same code path the
      // user would invoke from /portal/<id>/login. Gated by client_users
      // membership server-side (which the row trivially satisfies).
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, email }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `resend failed (HTTP ${res.status})`);
        return;
      }
      setNotice(`Invite re-sent to ${email}.`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
            Adding an email both grants portal access and sends a
            magic-link invite. Up to {PORTAL_USERS_PER_CLIENT} users
            per client.
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

      <div className="space-y-2 mb-5">
        {users.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No portal users yet. Add one below — they&rsquo;ll receive
            a magic-link invite immediately.
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
                    : 'never invited'}
              </span>
              <button
                type="button"
                onClick={() => onResend(u.id, u.email)}
                disabled={busy === `resend:${u.id}` || busy === 'add'}
                title="Re-send magic-link invite"
                className="text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                {busy === `resend:${u.id}` ? (
                  <Activity size={14} className="animate-pulse" />
                ) : (
                  <Mail size={14} />
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
