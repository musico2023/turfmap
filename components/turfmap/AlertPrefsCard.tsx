'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bell, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { withAlertPrefDefaults } from '@/lib/alerts/prefs';
import { canAccessGranularAlerts } from '@/lib/subscription/tier';
import type { AlertPrefs, SubscriptionTier } from '@/lib/supabase/types';

/**
 * Per-client alert preferences card on the settings page.
 *
 * Toggles per alert type (score movement, competitor entries, etc.)
 * with a numeric input for the score-movement threshold. The Slack
 * section uses an OAuth flow ("Add to Slack" → channel picker on
 * slack.com → webhook URL stored on the client row) instead of
 * webhook-URL paste.
 *
 * Saves toggles on submit via PATCH /api/clients/[id]. Slack
 * connection state is set out-of-band by the OAuth callback at
 * /api/integrations/slack/callback.
 *
 * Renders only on Pulse / Pulse+ / agency-managed clients — one_time
 * clients (TurfScan / Audit / Strategy buyers) bypass the card.
 */
export function AlertPrefsCard({
  clientId,
  clientPublicId,
  tier,
  initialPrefs,
  slackTeamName,
  slackChannelName,
  slackConnected,
}: {
  /** Client UUID — used by the disconnect endpoint. */
  clientId: string;
  /** Client public_id — used in the connect flow URL. */
  clientPublicId: string;
  /** Recurring tier — drives which alert toggles are unlocked. Pulse
   *  gets score-movement + weekly-summary; Pulse+ unlocks granular
   *  alerts (competitor entries, momentum reversal, cell changes) +
   *  Slack delivery. */
  tier: SubscriptionTier | null;
  initialPrefs: AlertPrefs | null;
  /** Slack workspace name (display only, for the connected pill). */
  slackTeamName: string | null;
  /** Slack channel name (display only). */
  slackChannelName: string | null;
  /** True iff slack_webhook_url is set on the client row — i.e. the
   *  OAuth flow completed and alerts will actually deliver. */
  slackConnected: boolean;
}) {
  const granularUnlocked = canAccessGranularAlerts(tier);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [prefs, setPrefs] = useState<AlertPrefs>(() =>
    withAlertPrefDefaults(initialPrefs)
  );
  const [submitting, setSubmitting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Surface OAuth callback outcomes (?slack=connected, ?slack=cancelled,
  // etc). Read on render — the URL is the source of truth.
  const slackParam = searchParams?.get('slack') ?? null;
  const slackErrorReason = searchParams?.get('reason') ?? null;
  const oauthNotice =
    slackParam === 'connected'
      ? { tone: 'ok' as const, message: 'Slack connected.' }
      : slackParam === 'cancelled'
        ? { tone: 'warn' as const, message: 'Slack connection cancelled.' }
        : slackParam === 'unavailable'
          ? {
              tone: 'warn' as const,
              message:
                'Slack integration not yet configured. Contact support.',
            }
          : slackParam && slackParam !== 'connected'
            ? {
                tone: 'error' as const,
                message: `Slack connection failed: ${slackParam}${slackErrorReason ? ` (${slackErrorReason})` : ''}`,
              }
            : null;

  const update = <K extends keyof AlertPrefs>(k: K, v: AlertPrefs[K]) => {
    setPrefs((s) => ({ ...s, [k]: v }));
    setSavedAt(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_prefs: prefs }),
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

  const onSlackDisconnect = async () => {
    setError(null);
    setDisconnecting(true);
    try {
      const res = await fetch('/api/integrations/slack/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `disconnect failed (HTTP ${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  const slackConnectUrl = `/api/integrations/slack/connect?client=${encodeURIComponent(clientPublicId)}`;

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

      <div
        className="border-t pt-4 mt-4"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold flex items-center gap-1.5">
            Slack delivery
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
          {slackConnected && (
            <span
              className="px-2 py-0.5 rounded text-[10px] uppercase tracking-[0.18em] font-bold flex items-center gap-1"
              style={{
                background: 'rgba(197, 255, 58, 0.12)',
                color: 'var(--color-lime, #c5ff3a)',
                border: '1px solid rgba(197, 255, 58, 0.3)',
              }}
            >
              CONNECTED
            </span>
          )}
        </div>

        {oauthNotice && (
          <div
            className="mb-3 rounded border px-3 py-2 text-xs"
            style={{
              background:
                oauthNotice.tone === 'ok'
                  ? 'rgba(197, 255, 58, 0.06)'
                  : oauthNotice.tone === 'warn'
                    ? 'rgba(255, 159, 58, 0.06)'
                    : 'rgba(255, 99, 99, 0.06)',
              borderColor:
                oauthNotice.tone === 'ok'
                  ? 'rgba(197, 255, 58, 0.3)'
                  : oauthNotice.tone === 'warn'
                    ? 'rgba(255, 159, 58, 0.3)'
                    : 'rgba(255, 99, 99, 0.3)',
              color:
                oauthNotice.tone === 'ok'
                  ? 'var(--color-lime, #c5ff3a)'
                  : oauthNotice.tone === 'warn'
                    ? '#ffb86b'
                    : '#ff8e8e',
            }}
          >
            {oauthNotice.message}
          </div>
        )}

        {slackConnected ? (
          <div
            className="rounded-md border p-3 flex items-center justify-between gap-3"
            style={{
              background: 'var(--color-bg)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-100">
                {slackTeamName ?? 'Connected workspace'}
                {slackChannelName && (
                  <span className="text-zinc-500 font-normal ml-1.5">
                    · {slackChannelName.startsWith('#') ? slackChannelName : `#${slackChannelName}`}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                All enabled alerts also POST to this channel. Click
                disconnect to stop Slack delivery without affecting
                email.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSlackDisconnect}
              loading={disconnecting}
              loadingLabel="Disconnecting…"
              disabled={!granularUnlocked}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div
            className="rounded-md border p-3"
            style={{
              background: 'var(--color-bg)',
              borderColor: 'var(--color-border)',
              opacity: granularUnlocked ? 1 : 0.5,
            }}
          >
            <p className="text-[11px] text-zinc-500 leading-relaxed mb-2.5">
              {granularUnlocked
                ? 'Pick a Slack workspace + channel. Slack handles the channel picker — no copy/paste needed. You can disconnect any time.'
                : 'Upgrade to Pulse+ to enable Slack delivery alongside email alerts.'}
            </p>
            {granularUnlocked ? (
              <a
                href={slackConnectUrl}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md font-bold text-sm transition-all"
                style={{
                  background: '#4A154B',
                  color: '#ffffff',
                  border: '1px solid #4A154B',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#611f64';
                  e.currentTarget.style.borderColor = '#611f64';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#4A154B';
                  e.currentTarget.style.borderColor = '#4A154B';
                }}
              >
                {/* Slack mark — official monogram colors. inline svg
                    keeps the asset out of /public for a single-use
                    glyph. */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 122.8 122.8"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
                    fill="#E01E5A"
                  />
                  <path
                    d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
                    fill="#36C5F0"
                  />
                  <path
                    d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
                    fill="#2EB67D"
                  />
                  <path
                    d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
                    fill="#ECB22E"
                  />
                </svg>
                Add to Slack
              </a>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                leftIcon={<Lock size={11} />}
              >
                Pulse+ required
              </Button>
            )}
          </div>
        )}
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
