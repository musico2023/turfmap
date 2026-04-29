'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Plus, Trash2 } from 'lucide-react';

export type ClientUserRow = {
  id: string;
  client_id: string;
  email: string;
  invited_at: string | null;
  last_login_at: string | null;
};

export type ClientUsersManagerProps = {
  clientId: string;
  users: ClientUserRow[];
};

export function ClientUsersManager({
  clientId,
  users,
}: ClientUsersManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
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
      setNewEmail('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (id: string) => {
    setError(null);
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
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4">
        <h3 className="font-display text-lg font-bold">Portal users</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          {users.length} user{users.length === 1 ? '' : 's'} can sign in to{' '}
          <span className="font-mono text-zinc-300">/portal/{clientId.slice(0, 8)}…</span>{' '}
          via magic link. Add an email below to grant access.
        </p>
      </div>

      <div className="space-y-2 mb-5">
        {users.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No portal users yet. Until you add one, the portal returns
            &quot;no access&quot; to anyone who signs in.
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
          placeholder="add a portal user (e.g. owner@client.com)"
          className="col-span-10 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
        <button
          type="submit"
          disabled={busy === 'add' || !newEmail.trim()}
          className="col-span-2 px-3 py-2 rounded-md font-bold text-xs flex items-center justify-center gap-1.5 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
          }}
        >
          {busy === 'add' ? (
            <Activity size={12} className="animate-pulse" />
          ) : (
            <>
              <Plus size={12} strokeWidth={2.75} /> Add
            </>
          )}
        </button>
      </form>
      {error && (
        <div className="text-xs text-red-400 font-mono mt-3">{error}</div>
      )}
    </div>
  );
}
