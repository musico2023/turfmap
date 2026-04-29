'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Plus, Trash2 } from 'lucide-react';
import type { ScanFrequency, TrackedKeywordRow } from '@/lib/supabase/types';

export type KeywordsManagerProps = {
  clientId: string;
  keywords: TrackedKeywordRow[];
};

export function KeywordsManager({ clientId, keywords }: KeywordsManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [newKeyword, setNewKeyword] = useState('');
  const [newFrequency, setNewFrequency] = useState<ScanFrequency>('weekly');
  const [makePrimary, setMakePrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!newKeyword.trim()) return;

    setBusy('add');
    try {
      const res = await fetch('/api/keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          keyword: newKeyword.trim(),
          scan_frequency: newFrequency,
          is_primary: makePrimary,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      setNewKeyword('');
      setMakePrimary(false);
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
      const res = await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
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
        <h3 className="font-display text-lg font-bold">Tracked keywords</h3>
        <p className="text-xs text-zinc-500 mt-0.5">
          {keywords.length} keyword{keywords.length === 1 ? '' : 's'} · scheduled
          scans run on each keyword&apos;s frequency.
        </p>
      </div>

      {/* List */}
      <div className="space-y-2 mb-5">
        {keywords.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No keywords. Add one below — without a keyword, scheduled scans skip
            this client.
          </div>
        ) : (
          keywords.map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md border"
              style={{
                background: 'var(--color-bg)',
                borderColor: 'var(--color-border)',
              }}
            >
              <span className="font-mono text-sm text-zinc-100 flex-1 truncate">
                {k.keyword}
              </span>
              {k.is_primary && (
                <span
                  className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded border"
                  style={{
                    background: '#1a2010',
                    color: 'var(--color-lime)',
                    borderColor: 'var(--color-border-bright)',
                  }}
                >
                  PRIMARY
                </span>
              )}
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                {k.scan_frequency ?? 'weekly'}
              </span>
              <button
                type="button"
                onClick={() => onDelete(k.id)}
                disabled={busy === k.id}
                title="Remove keyword"
                className="text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {busy === k.id ? (
                  <Activity size={14} className="animate-pulse" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add form */}
      <form onSubmit={onAdd} className="space-y-3">
        <div className="grid grid-cols-12 gap-2">
          <input
            type="text"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            placeholder="add another keyword (e.g. 'water heater repair')"
            className="col-span-7 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
          <select
            value={newFrequency}
            onChange={(e) =>
              setNewFrequency(e.target.value as ScanFrequency)
            }
            className="col-span-3 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors"
          >
            <option value="weekly">weekly</option>
            <option value="biweekly">biweekly</option>
            <option value="monthly">monthly</option>
            <option value="daily">daily</option>
          </select>
          <button
            type="submit"
            disabled={busy === 'add' || !newKeyword.trim()}
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
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-500 select-none">
          <input
            type="checkbox"
            checked={makePrimary}
            onChange={(e) => setMakePrimary(e.target.checked)}
            className="accent-[var(--color-lime)]"
          />
          Make this the primary keyword (replaces the current primary)
        </label>
        {error && (
          <div className="text-xs text-red-400 font-mono">{error}</div>
        )}
      </form>
    </div>
  );
}
