'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Crown, Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { tierLabel } from '@/lib/subscription/tier';
import type { SubscriptionTier } from '@/lib/supabase/types';

/**
 * Agency-side tier override card.
 *
 * Lets the operator manually flip a client between Pulse and Pulse+
 * without touching Stripe — useful for demo accounts, agency-managed
 * contracts where Stripe isn't the source of truth, or for recovery
 * when a webhook hasn't yet fired.
 *
 * Three buttons: Pulse, Pulse+, Clear (NULL — "no recurring tier").
 * Active tier is shown as a pill; the matching button is disabled.
 *
 * The override writes to clients.tier directly. The Stripe webhook
 * (when wired) and the upgrade endpoint also write the same column,
 * so the resolver in lib/subscription/tier.ts is always reading from
 * one source of truth.
 */
export type TierOverrideCardProps = {
  clientId: string;
  initialTier: SubscriptionTier | null;
};

export function TierOverrideCard({
  clientId,
  initialTier,
}: TierOverrideCardProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tier, setTier] = useState<SubscriptionTier | null>(initialTier);
  const [busy, setBusy] = useState<SubscriptionTier | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setOverride = async (next: SubscriptionTier | null) => {
    setError(null);
    setNotice(null);
    setBusy(next ?? 'clear');
    try {
      const res = await fetch(`/api/clients/${clientId}/tier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? `update failed (HTTP ${res.status})`);
        return;
      }
      setTier(next);
      setNotice(
        next ? `Tier set to ${tierLabel(next)}.` : 'Recurring tier cleared.'
      );
      startTransition(() => router.refresh());
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
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="font-display text-lg font-bold flex items-center gap-2">
            <Crown size={15} style={{ color: 'var(--color-lime)' }} />
            Plan tier
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-md">
            Operator override for the client&rsquo;s recurring tier.
            Drives feature gating across the dashboard, portal, alerts,
            exports, and keyword caps. Stripe webhooks (when wired)
            write the same column.
          </p>
        </div>
        <span
          className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold whitespace-nowrap"
          style={{
            background:
              tier === 'pulse_plus'
                ? 'rgba(197, 255, 58, 0.12)'
                : tier === 'pulse'
                  ? 'rgba(255, 255, 255, 0.04)'
                  : 'rgba(255, 159, 58, 0.06)',
            color:
              tier === 'pulse_plus'
                ? 'var(--color-lime, #c5ff3a)'
                : tier === 'pulse'
                  ? '#a1a1aa'
                  : '#ffb86b',
            border: `1px solid ${
              tier === 'pulse_plus'
                ? 'rgba(197, 255, 58, 0.3)'
                : tier === 'pulse'
                  ? 'rgba(255, 255, 255, 0.1)'
                  : 'rgba(255, 159, 58, 0.3)'
            }`,
          }}
        >
          {tierLabel(tier)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={tier === 'pulse' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setOverride('pulse')}
          disabled={tier === 'pulse' || busy !== null}
          loading={busy === 'pulse'}
          loadingLabel="Saving…"
        >
          Pulse
        </Button>
        <Button
          variant={tier === 'pulse_plus' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setOverride('pulse_plus')}
          disabled={tier === 'pulse_plus' || busy !== null}
          loading={busy === 'pulse_plus'}
          loadingLabel="Saving…"
        >
          Pulse+
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOverride(null)}
          disabled={tier === null || busy !== null}
          loading={busy === 'clear'}
          loadingLabel="Clearing…"
        >
          Clear
        </Button>

        {error && (
          <span className="text-xs text-red-400 font-mono ml-auto">
            {error}
          </span>
        )}
        {!error && notice && (
          <span
            className="text-xs font-mono ml-auto flex items-center gap-1"
            style={{ color: 'var(--color-lime)' }}
          >
            <Activity size={11} />
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}
