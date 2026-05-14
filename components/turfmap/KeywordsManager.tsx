'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Lock, Plus, Trash2 } from 'lucide-react';
import type {
  ScanFrequency,
  SubscriptionTier,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { Button } from '@/components/ui/Button';
import { maxKeywordsPerLocation } from '@/lib/subscription/tier';

export type KeywordsManagerProps = {
  clientId: string;
  /** Optional — which location these keywords belong to. New keywords
   *  are created on this location. Multi-location settings page passes
   *  the active location; legacy callers pass null and the API defaults
   *  to the client's primary. */
  locationId?: string | null;
  /** Display label for the active location (shown in the card title for
   *  multi-location clients so the operator sees which location's
   *  keywords are listed). */
  locationLabel?: string | null;
  /** Recurring tier — drives the per-location keyword cap (Pulse: 3,
   *  Pulse+: 10, NULL: 1). The API enforces; this prop is for UX (the
   *  counter and the disabled-at-cap state). Pass null for one_time
   *  clients or when tier is unset. */
  tier?: SubscriptionTier | null;
  /** Pre-computed industry+city-based keyword chips (e.g. ["pediatrician
   *  toronto", "pediatric clinic toronto", ...]). Click → fills the
   *  input. Empty array hides the suggestion row. Computed server-side
   *  via lib/keywords/suggestions.buildKeywordSuggestions. */
  suggestions?: string[];
  keywords: TrackedKeywordRow[];
};

export function KeywordsManager({
  clientId,
  locationId = null,
  locationLabel = null,
  tier = null,
  suggestions = [],
  keywords,
}: KeywordsManagerProps) {
  const cap = maxKeywordsPerLocation(tier);
  const atCap = keywords.length >= cap;
  const overage = Math.max(0, keywords.length - cap);
  const isOverCap = overage > 0;
  const upgradeHint =
    tier === 'pulse' ? ' — upgrade to Pulse+ for 10' : '';

  // Determine which keywords are inside vs outside the tier cap.
  // Same ordering as the cron and /api/scans/trigger: primary first,
  // then earliest-created. The first `cap` rows are scannable; the
  // rest render with a "scans paused" badge. Backend enforces the
  // same cutoff — this is purely UI affordance.
  const orderedForCap = [...keywords].sort((a, b) => {
    const ap = a.is_primary ? 1 : 0;
    const bp = b.is_primary ? 1 : 0;
    if (ap !== bp) return bp - ap; // primary first
    const at = a.created_at ?? '';
    const bt = b.created_at ?? '';
    return at.localeCompare(bt);
  });
  const overCapIds = new Set(orderedForCap.slice(cap).map((k) => k.id));
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
          location_id: locationId ?? undefined,
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
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-lg font-bold">
            Tracked keywords
            {locationLabel && (
              <span className="text-xs text-zinc-500 font-normal ml-2">
                · {locationLabel}
              </span>
            )}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {isOverCap ? (
              <>
                <span style={{ color: '#ffb86b' }}>
                  {keywords.length} keyword{keywords.length === 1 ? '' : 's'}
                </span>{' '}
                · {cap} included on plan, {overage} over · scheduled scans run on
                each keyword&apos;s frequency.
              </>
            ) : (
              <>
                {keywords.length} of {cap} keyword{cap === 1 ? '' : 's'} ·
                scheduled scans run on each keyword&apos;s frequency.
              </>
            )}
          </p>
        </div>
        <span
          className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold whitespace-nowrap"
          style={{
            background: atCap
              ? 'rgba(255, 159, 58, 0.06)'
              : 'rgba(255, 255, 255, 0.04)',
            color: atCap ? '#ffb86b' : '#a1a1aa',
            border: `1px solid ${atCap ? 'rgba(255, 159, 58, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
          }}
          title={
            atCap
              ? `You've used all ${cap} keyword slots${upgradeHint}.`
              : `${cap - keywords.length} of ${cap} slots remaining.`
          }
        >
          {keywords.length} / {cap}
        </span>
      </div>

      {/* List */}
      <div className="space-y-2 mb-5">
        {keywords.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No keywords. Add one below — without a keyword, scheduled scans skip
            this client.
          </div>
        ) : (
          keywords.map((k) => {
            const overCap = overCapIds.has(k.id);
            return (
              <div
                key={k.id}
                className="flex items-center gap-3 px-3 py-2 rounded-md border transition-opacity"
                style={{
                  background: 'var(--color-bg)',
                  borderColor: overCap
                    ? 'rgba(255, 159, 58, 0.25)'
                    : 'var(--color-border)',
                  opacity: overCap ? 0.7 : 1,
                }}
                title={
                  overCap
                    ? `Over your ${cap}-keyword plan — scheduled and on-demand scans are paused for this keyword. Remove an earlier keyword or upgrade to resume scanning.`
                    : undefined
                }
              >
                <span
                  className={`font-mono text-sm flex-1 truncate ${overCap ? 'text-zinc-400 line-through decoration-zinc-600' : 'text-zinc-100'}`}
                >
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
                {overCap && (
                  <span
                    className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded border flex items-center gap-1"
                    style={{
                      background: 'rgba(255, 159, 58, 0.06)',
                      color: '#ffb86b',
                      borderColor: 'rgba(255, 159, 58, 0.3)',
                    }}
                  >
                    <Lock size={9} />
                    SCANS PAUSED
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
            );
          })
        )}
      </div>

      {/* Suggestion chips — affordances are explicit: a + icon, hover
          glow, and a small label tell the operator they're clickable.
          Click fills the input below so they can edit before submitting. */}
      {suggestions.length > 0 && !atCap && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center gap-1.5">
            <span>Suggestions</span>
            <span className="text-zinc-600 normal-case tracking-normal font-normal">
              click to add
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions
              .filter(
                (s) =>
                  !keywords.some((k) => k.keyword.toLowerCase() === s.toLowerCase())
              )
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setNewKeyword(s)}
                  title={`Use "${s}" as the new keyword`}
                  className="group px-2 py-1 rounded-md text-[11px] font-mono border transition-all flex items-center gap-1 hover:scale-[1.02] focus:outline-none focus:ring-1 focus:ring-[var(--color-lime)]"
                  style={{
                    borderColor: 'var(--color-border)',
                    background: 'var(--color-bg)',
                    color: '#a1a1aa',
                  }}
                  // Inline mouse handlers paint hover state via the
                  // CSS vars instead of a brittle Tailwind hover: combo
                  // (which can't easily target both border AND lime icon
                  // tint together in our setup).
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-lime)';
                    e.currentTarget.style.background = '#0d130a';
                    e.currentTarget.style.color = 'var(--color-lime)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor =
                      'var(--color-border)';
                    e.currentTarget.style.background = 'var(--color-bg)';
                    e.currentTarget.style.color = '#a1a1aa';
                  }}
                >
                  <Plus
                    size={10}
                    strokeWidth={2.5}
                    className="opacity-60 group-hover:opacity-100 transition-opacity"
                  />
                  {s}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Add form */}
      <form onSubmit={onAdd} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <input
            type="text"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            disabled={atCap}
            placeholder={
              atCap
                ? `Keyword cap reached${upgradeHint}`
                : "add another keyword (e.g. 'water heater repair')"
            }
            className="sm:col-span-7 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <select
            value={newFrequency}
            onChange={(e) =>
              setNewFrequency(e.target.value as ScanFrequency)
            }
            disabled={atCap}
            className="sm:col-span-3 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="weekly">weekly</option>
            <option value="biweekly">biweekly</option>
            <option value="monthly">monthly</option>
            <option value="daily">daily</option>
          </select>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!newKeyword.trim() || atCap}
            loading={busy === 'add'}
            leftIcon={
              atCap ? (
                <Lock size={12} strokeWidth={2.75} />
              ) : (
                <Plus size={12} strokeWidth={2.75} />
              )
            }
            className="sm:col-span-2"
          >
            {atCap ? 'At cap' : 'Add'}
          </Button>
        </div>
        <label
          className={`flex items-center gap-2 text-xs select-none ${atCap ? 'text-zinc-700' : 'text-zinc-500'}`}
        >
          <input
            type="checkbox"
            checked={makePrimary}
            onChange={(e) => setMakePrimary(e.target.checked)}
            disabled={atCap}
            className="accent-[var(--color-lime)] disabled:cursor-not-allowed"
          />
          Make this the primary keyword (replaces the current primary)
        </label>
        {atCap && (
          <p className="text-xs text-zinc-500">
            <span
              className="font-semibold"
              style={{ color: isOverCap ? '#ffb86b' : '#e4e4e7' }}
            >
              {isOverCap
                ? `${overage} over your ${cap}-keyword plan`
                : `${cap}/${cap} keyword slots used`}
            </span>
            {isOverCap
              ? tier === 'pulse'
                ? ` — remove ${overage} to add new, or upgrade to Pulse+ for 10.`
                : ` — remove ${overage} to add new, or contact support.`
              : tier === 'pulse'
                ? ' — Pulse+ unlocks 10 per location.'
                : tier === 'pulse_plus'
                  ? ' — contact support to add custom slots.'
                  : ' — set a recurring tier to add more.'}
          </p>
        )}
        {error && (
          <div className="text-xs text-red-400 font-mono">{error}</div>
        )}
      </form>
    </div>
  );
}
