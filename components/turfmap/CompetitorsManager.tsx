'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Crown, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type TrackedCompetitorRow = {
  id: string;
  competitor_name: string;
};

export type CompetitorsManagerProps = {
  clientId: string;
  /** UUID of the active location these competitors are pinned to.
   *  Null when the client has no resolved location (shouldn't happen
   *  post-migration 0006); the manager hides itself in that case. */
  locationId: string | null;
  /** Display label for the active location — surfaced in the card
   *  title so the operator knows which location's list they're
   *  editing in a multi-location setup. */
  locationLabel: string | null;
  competitors: TrackedCompetitorRow[];
};

/**
 * Operator-facing manager for the per-location curated competitor list.
 *
 * Default behavior — empty list — produces automatic competitor
 * discovery on the dashboard: every brand observed in the scan's
 * 3-pack populates the right rail without operator effort.
 *
 * When the operator adds names here, the dashboard switches to
 * curated mode for THIS location: only those brands are surfaced,
 * and a brand at 0% share (i.e., not in the pack on this scan) still
 * appears below the fold in the CompetitorTable's expander as
 * whitespace-signal data.
 *
 * Each location has its own independent list. Adding "Aspen Dental"
 * to the Wychwood location doesn't affect the Don Mills view.
 */
export function CompetitorsManager({
  clientId,
  locationId,
  locationLabel,
  competitors,
}: CompetitorsManagerProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'add' | string | null>(null);

  const refresh = () => startTransition(() => router.refresh());
  // Mirrors the server-side cap in app/api/competitors/route.ts —
  // matches the Pulse+ marketing promise of "up to 5 competitors."
  const COMPETITORS_PER_LOCATION = 5;
  const atCap = competitors.length >= COMPETITORS_PER_LOCATION;

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!newName.trim() || !locationId) return;
    setBusy('add');
    try {
      const res = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          location_id: locationId,
          competitor_name: newName.trim(),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `add failed (HTTP ${res.status})`);
        return;
      }
      setNewName('');
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
      const res = await fetch(`/api/competitors/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
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
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">
            Tracked competitors
            {locationLabel && (
              <span className="text-xs text-zinc-500 font-normal ml-2">
                · {locationLabel}
              </span>
            )}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 max-w-2xl">
            Leave empty for automatic discovery — every brand observed in
            the local 3-pack populates the dashboard. Add specific brands
            here to track them even when they don&rsquo;t appear in this
            location&rsquo;s scans (useful when you know a competitor exists
            but want to verify their territory presence).
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
          {competitors.length} / {COMPETITORS_PER_LOCATION}
        </span>
      </div>

      {error && (
        <div
          className="border rounded-md p-3 mb-3 text-xs font-mono"
          style={{
            background: '#1a0606',
            borderColor: '#3f0a0a',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}

      {competitors.length === 0 ? (
        <div className="text-xs text-zinc-600 italic mb-4">
          No tracked competitors — dashboard is in automatic discovery mode.
        </div>
      ) : (
        <div className="space-y-2 mb-5">
          {competitors.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md border"
              style={{
                background: 'var(--color-bg)',
                borderColor: 'var(--color-border)',
              }}
            >
              <Crown size={12} className="text-zinc-500 flex-shrink-0" />
              <span className="text-sm text-zinc-100 flex-1 truncate">
                {c.competitor_name}
              </span>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                disabled={busy === c.id}
                title="Remove competitor"
                className="text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {busy === c.id ? (
                  <Activity size={14} className="animate-pulse" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={onAdd} className="grid grid-cols-12 gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={
            atCap
              ? 'remove a competitor before adding another'
              : 'Competitor brand name (e.g. Kindercare Pediatrics)'
          }
          disabled={!locationId || atCap}
          className="col-span-10 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-50"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!newName.trim() || !locationId || atCap}
          loading={busy === 'add'}
          leftIcon={<Plus size={12} strokeWidth={2.75} />}
          className="col-span-2"
        >
          Add
        </Button>
      </form>
    </div>
  );
}
