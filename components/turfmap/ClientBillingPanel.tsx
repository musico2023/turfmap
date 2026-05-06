'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, ExternalLink, Sparkles, Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { tierLabel } from '@/lib/subscription/tier';
import type { SubscriptionTier } from '@/lib/supabase/types';

/**
 * Client-portal billing panel.
 *
 * Shown only when the client is on a recurring subscription (Pulse or
 * Pulse+). Surfaces:
 *   - Current tier (badge) + status
 *   - Next billing date
 *   - "Manage billing" button — opens the Stripe Customer Portal
 *     (invoices, payment methods, cancellation)
 *   - "Upgrade to Pulse+" button — only when tier='pulse'; opens an
 *     inline upgrade flow that hits /api/portal/upgrade and redirects
 *     to the portal's payment-method update page so Stripe captures
 *     any prorated charge cleanly.
 *
 * Renders nothing for one_time clients — they bought a one-shot
 * product and have no recurring billing relationship to manage.
 */
export type ClientBillingPanelProps = {
  /** Client UUID — passed to /api/portal/* endpoints. */
  clientId: string;
  tier: SubscriptionTier | null;
  /** Server-loaded subscription summary. NULL when the client has no
   *  Stripe subscription on file (agency-managed) — panel renders
   *  read-only tier info in that case. */
  summary:
    | {
        ok: true;
        status: string;
        currentPeriodEnd: string;
        cancelAtPeriodEnd: boolean;
        minimumCommitmentEnd: string | null;
        inCommittedPhase: boolean;
      }
    | { ok: false; kind: string; message: string }
    | null;
};

export function ClientBillingPanel({
  clientId,
  tier,
  summary,
}: ClientBillingPanelProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<'portal' | 'upgrade' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openBillingPortal = async () => {
    setError(null);
    setNotice(null);
    setBusy('portal');
    try {
      const res = await fetch('/api/portal/billing-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? `unable to open billing portal (HTTP ${res.status})`);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const upgradeToPulsePlus = async () => {
    setError(null);
    setNotice(null);
    setBusy('upgrade');
    try {
      const res = await fetch('/api/portal/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? `upgrade failed (HTTP ${res.status})`);
        return;
      }
      setNotice('You’re now on Pulse+. Pulse+ features unlock on your next page refresh.');
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tierBadge = (
    <span
      className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold whitespace-nowrap"
      style={{
        background:
          tier === 'pulse_plus'
            ? 'rgba(197, 255, 58, 0.12)'
            : 'rgba(255, 255, 255, 0.04)',
        color:
          tier === 'pulse_plus'
            ? 'var(--color-lime, #c5ff3a)'
            : '#a1a1aa',
        border: `1px solid ${
          tier === 'pulse_plus'
            ? 'rgba(197, 255, 58, 0.3)'
            : 'rgba(255, 255, 255, 0.1)'
        }`,
      }}
    >
      {tierLabel(tier)}
    </span>
  );

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
            <CreditCard size={15} className="text-zinc-400" />
            Billing
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-md">
            Your subscription, invoices, and payment methods. Managed
            through Stripe.
          </p>
        </div>
        {tierBadge}
      </div>

      {summary && summary.ok && (
        <div className="space-y-2.5 mb-4">
          <Row label="Status" value={pretty(summary.status)} />
          <Row
            label={
              summary.cancelAtPeriodEnd ? 'Access ends' : 'Next billing'
            }
            value={summary.currentPeriodEnd.slice(0, 10)}
          />
          {summary.cancelAtPeriodEnd && (
            <div
              className="rounded border px-3 py-2 text-xs"
              style={{
                background: 'rgba(255, 159, 58, 0.06)',
                borderColor: 'rgba(255, 159, 58, 0.3)',
                color: '#ffb86b',
              }}
            >
              Cancellation scheduled — access ends{' '}
              {summary.currentPeriodEnd.slice(0, 10)}.
            </div>
          )}
          {summary.inCommittedPhase && summary.minimumCommitmentEnd && (
            <div
              className="rounded border px-3 py-2 text-xs"
              style={{
                background: 'var(--color-card-glow)',
                borderColor: 'var(--color-border-bright)',
                color: 'var(--color-lime)',
              }}
            >
              <strong>Minimum commitment ends</strong>{' '}
              {summary.minimumCommitmentEnd.slice(0, 10)}.
            </div>
          )}
        </div>
      )}

      {summary && !summary.ok && (
        <p className="text-xs text-zinc-500 italic mb-4">
          Subscription details temporarily unavailable.
        </p>
      )}

      {!summary && (
        <p className="text-xs text-zinc-500 italic mb-4">
          Billing managed by your account team. Contact support for
          changes.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {summary && summary.ok && (
          <Button
            variant="secondary"
            size="md"
            onClick={openBillingPortal}
            loading={busy === 'portal'}
            loadingLabel="Opening…"
            disabled={busy !== null}
            leftIcon={<ExternalLink size={12} />}
          >
            Manage billing
          </Button>
        )}
        {tier === 'pulse' && summary && summary.ok && (
          <Button
            variant="primary"
            size="md"
            onClick={upgradeToPulsePlus}
            loading={busy === 'upgrade'}
            loadingLabel="Upgrading…"
            disabled={busy !== null}
            leftIcon={<Sparkles size={12} />}
          >
            Upgrade to Pulse+
          </Button>
        )}

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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
        {label}
      </span>
      <span className="font-mono text-zinc-200">{value}</span>
    </div>
  );
}

function pretty(status: string): string {
  if (!status) return '—';
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}
