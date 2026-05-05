'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { withAlertPrefDefaults } from '@/lib/alerts/prefs';
import { canAccessGranularAlerts } from '@/lib/subscription/tier';
import type { AlertPrefs, SubscriptionTier } from '@/lib/supabase/types';

/**
 * Per-client alert preferences card on the settings page.
 *
 * One row per toggle, with a numeric input for the score-movement
 * threshold. Slack webhook URL is at the bottom — empty clears,
 * non-empty must match the standard https://hooks.slack.com/ format
 * (the API rejects anything else).
 *
 * Saves on submit with a single PATCH to /api/clients/[id]; the
 * route merges alert_prefs against the existing row so a single
 * toggle flip doesn't blank the rest.
 *
 * Renders only on Pulse / Pulse+ / agency-managed clients — one_time
 * clients (TurfScan / Audit / Strategy buyers) bypass the card.
 */
export function AlertPrefsCard({
  clientId,
  tier,
  initialPrefs,
  initialSlackWebhookUrl,
}: {
  clientId: string;
  /** Recurring tier — drives which alert toggles are unlocked. Pulse
   *  gets score-movement + weekly-summary; Pulse+ unlocks granular
   *  alerts (competitor entries, momentum reversal, cell changes) +
   *  Slack delivery. */
  tier: SubscriptionTier | null;
  initialPrefs: AlertPrefs | null;
  initialSlackWebhookUrl: string | null;
}) {
  const granularUnlocked = canAccessGranularAlerts(tier);
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [prefs, setPrefs] = useState<AlertPrefs>(() =>
    withAlertPrefDefaults(initialPrefs)
  );
  const [slackUrl, setSlackUrl] = useState<string>(
    initialSlackWebhookUrl ?? ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const update = <K extends keyof AlertPrefs>(k: K, v: AlertPrefs[K]) => {
    setPrefs((s) => ({ ...s, [k]: v }));
    setSavedAt(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedSlack = slackUrl.trim();
    if (
      trimmedSlack &&
      !/^https:\/\/hooks\.slack\.com\//.test(trimmedSlack)
    ) {
      setError(
        'Slack webhook must be a https://hooks.slack.com/... URL.'
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert_prefs: prefs,
          slack_webhook_url: trimmedSlack === '' ? null : trimmedSlack,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(Date.now());
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-4 flex items-start gap-3">
        <Bell
          size={16}
          className="flex-shrink-0 mt-0.5"
          style={{ color: 'var(--color-lime)' }}
        />
        <div>
          <h3 className="font-display text-lg font-bold">Alerts</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Email and Slack alerts fire after each scan, debounced 6
            hours per type so a flapping score doesn&rsquo;t spam the
            inbox. Recipients = portal users on this client.
          </p>
        </div>
      </div>

      <div className="space-y-2.5 mb-5">
        <Toggle
          label="Score movement"
          help={
            <>
              Email when TurfScore moves by ≥{' '}
              <input
                type="number"
                min={1}
                max={100}
                value={prefs.score_movement_threshold}
                onChange={(e) =>
                  update(
                    'score_movement_threshold',
                    Math.max(1, Math.min(100, Number(e.target.value) || 1))
                  )
                }
                className="w-12 mx-1 px-1.5 py-0.5 rounded border bg-[var(--color-bg)] border-[var(--color-border)] text-xs font-mono text-zinc-100 text-center"
              />
              points
            </>
          }
          on={prefs.score_movement_email}
          onChange={(v) => update('score_movement_email', v)}
        />
        <Toggle
          label="Competitor entries"
          help="Email when a new competitor brand enters your 3-pack."
          on={prefs.competitor_entries_email}
          onChange={(v) => update('competitor_entries_email', v)}
          locked={!granularUnlocked}
        />
        <Toggle
          label="Momentum reversal"
          help="Email when momentum flips positive ↔ negative."
          on={prefs.momentum_reversal_email}
          onChange={(v) => update('momentum_reversal_email', v)}
          locked={!granularUnlocked}
        />
        <Toggle
          label="Cell-level changes"
          help="Email a per-cell movement summary after each scan. Noisy — opt-in."
          on={prefs.cell_changes_email}
          onChange={(v) => update('cell_changes_email', v)}
          locked={!granularUnlocked}
        />
        <Toggle
          label="Weekly competitor summary"
          help="Roll-up of competitor activity across the prior week. Sent Mondays."
          on={prefs.weekly_competitor_summary_email}
          onChange={(v) => update('weekly_competitor_summary_email', v)}
        />
      </div>

      <div className="border-t pt-4 mt-4" style={{ borderColor: 'var(--color-border)' }}>
        <label className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold mb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            Slack webhook URL
            {!granularUnlocked && (
              <span
                className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: '#a1a1aa',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                PULSE+
              </span>
            )}
          </span>
          <span className="text-[10px] normal-case tracking-normal text-zinc-600">
            Slack → Apps → Incoming Webhooks → copy URL
          </span>
        </label>
        <input
          type="url"
          value={slackUrl}
          onChange={(e) => {
            setSlackUrl(e.target.value);
            setSavedAt(null);
          }}
          disabled={!granularUnlocked}
          placeholder={
            granularUnlocked
              ? 'https://hooks.slack.com/services/T0/B0/xyz'
              : 'Upgrade to Pulse+ to enable Slack delivery'
          }
          className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
          When set, all enabled alerts also POST to this Slack
          channel. Leave empty to disable Slack delivery.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4">
        {error && (
          <span className="text-xs text-red-400 font-mono mr-auto">
            {error}
          </span>
        )}
        {!error && savedAt && (
          <span className="text-xs text-zinc-500 font-mono mr-auto">
            ✓ Saved
          </span>
        )}
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          loadingLabel="Saving…"
        >
          Save alert prefs
        </Button>
      </div>
    </form>
  );
}

function Toggle({
  label,
  help,
  on,
  onChange,
  locked,
}: {
  label: string;
  help: React.ReactNode;
  on: boolean;
  onChange: (next: boolean) => void;
  /** Pulse+-only toggle on a Pulse plan: render as disabled with a
   *  PULSE+ pill, ignore changes. */
  locked?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-md border transition-colors ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      style={{
        background:
          locked
            ? 'rgba(255, 255, 255, 0.02)'
            : on
              ? 'var(--color-card-glow)'
              : 'var(--color-bg)',
        borderColor:
          !locked && on
            ? 'var(--color-border-bright)'
            : 'var(--color-border)',
        opacity: locked ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={locked ? false : on}
        disabled={locked}
        onChange={(e) => {
          if (locked) return;
          onChange(e.target.checked);
        }}
        className="mt-0.5 w-4 h-4 accent-[var(--color-lime)] disabled:cursor-not-allowed"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100 flex items-center gap-1.5">
          {label}
          {locked && (
            <span
              className="px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center gap-1"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                color: '#a1a1aa',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <Lock size={9} />
              PULSE+
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-500 leading-relaxed mt-0.5">
          {help}
        </div>
      </div>
    </label>
  );
}
