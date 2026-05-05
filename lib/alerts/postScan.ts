/**
 * Post-scan alert orchestrator.
 *
 * Called by lib/scans/runScan after a scan lands. Pulls the prior
 * scan + both scans' cells + competitor names, runs the typed
 * diffs, filters by client AlertPrefs, debounces against
 * alerts_last_fired_at, and fans out via lib/alerts/dispatch.
 *
 * Best-effort end-to-end: every step swallows errors and logs. A
 * failure here never breaks the scan return path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyAlertPrefs,
  diffScans,
  extractCompetitorNames,
  shouldDebounce,
  type AlertEvent,
} from './diff';
import { dispatchAlert } from './dispatch';
import { withAlertPrefDefaults } from './prefs';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  AlertPrefs,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type DispatchScanAlertsInput = {
  clientId: string;
  locationId: string;
  keywordId: string;
  currentScanId: string;
  currentScore: number | null;
  currentMomentum: number | null;
};

export async function dispatchScanAlerts(
  supabase: SupabaseLike,
  input: DispatchScanAlertsInput
): Promise<{ events: AlertEvent[]; dispatched: number; suppressed: number }> {
  // 1. Load client config (alert_prefs, slack url, debounce map,
  //    business_name, public_id, alert recipient list).
  const { data: client } = await supabase
    .from('clients')
    .select(
      'id, public_id, business_name, alert_prefs, slack_webhook_url, alerts_last_fired_at, billing_mode'
    )
    .eq('id', input.clientId)
    .maybeSingle<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'business_name'
        | 'alert_prefs'
        | 'slack_webhook_url'
        | 'alerts_last_fired_at'
        | 'billing_mode'
      >
    >();
  if (!client) {
    return { events: [], dispatched: 0, suppressed: 0 };
  }

  // Alerts are a Pulse / Pulse+ / agency-managed feature. one_time
  // clients (TurfScan / Audit / Strategy buyers) don't get alerts —
  // they bought a one-shot product, not a monitoring subscription.
  if (client.billing_mode === 'one_time') {
    return { events: [], dispatched: 0, suppressed: 0 };
  }

  const prefs: AlertPrefs = withAlertPrefDefaults(client.alert_prefs);
  const lastFired = client.alerts_last_fired_at ?? {};

  // 2. Pull current + prior scan cells + the immediately-prior
  //    completed scan for this (client, location, keyword) tuple
  //    so the diff functions have enough context.
  const [{ data: currentCells }, { data: priorScan }] = await Promise.all([
    supabase
      .from('scan_points')
      .select('grid_x, grid_y, rank, competitors')
      .eq('scan_id', input.currentScanId)
      .returns<
        Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank' | 'competitors'>[]
      >(),
    supabase
      .from('scans')
      .select('id, turf_score, momentum')
      .eq('client_id', input.clientId)
      .eq('location_id', input.locationId)
      .eq('keyword_id', input.keywordId)
      .eq('status', 'complete')
      .neq('id', input.currentScanId)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle<Pick<ScanRow, 'id' | 'turf_score' | 'momentum'>>(),
  ]);

  // 3. Pull the prior scan's cells when a prior scan exists. Used
  //    by the cell-changes diff.
  const { data: priorCells } = priorScan
    ? await supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, competitors')
        .eq('scan_id', priorScan.id)
        .returns<
          Pick<
            ScanPointRow,
            'grid_x' | 'grid_y' | 'rank' | 'competitors'
          >[]
        >()
    : { data: [] as Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank' | 'competitors'>[] };

  // 4. Run diffs.
  const events = diffScans({
    current: {
      turf_score: input.currentScore,
      momentum: input.currentMomentum,
    },
    prior: priorScan
      ? { turf_score: priorScan.turf_score, momentum: priorScan.momentum }
      : null,
    currentCells: currentCells ?? [],
    priorCells: priorCells ?? [],
    currentCompetitorNames: extractCompetitorNames(currentCells ?? []),
    priorCompetitorNames: extractCompetitorNames(priorCells ?? []),
  });

  // 5. Apply prefs + debounce.
  const filtered = applyAlertPrefs(events, prefs).filter(
    (e) => !shouldDebounce(e.type, lastFired)
  );

  if (filtered.length === 0) {
    return {
      events,
      dispatched: 0,
      suppressed: events.length - filtered.length,
    };
  }

  // 6. Resolve recipient list. For now: every client_users email
  //    gets a copy. Future iteration could add a per-user opt-out
  //    column; for v1 the alert prefs gate the firing, not the
  //    recipient list.
  const { data: portalUsers } = await supabase
    .from('client_users')
    .select('email')
    .eq('client_id', client.id)
    .returns<{ email: string }[]>();
  const emailRecipients = (portalUsers ?? [])
    .map((u) => u.email)
    .filter(Boolean);

  // Origin for the dashboard link. NEXT_PUBLIC_APP_URL is set in
  // production; locally / preview falls back to turfmap.ai so links
  // are at least shaped right.
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const dashboardUrl = `${origin}/portal/${client.public_id}`;

  // 7. Dispatch.
  let dispatched = 0;
  const newLastFired: Record<string, string> = { ...lastFired };
  for (const event of filtered) {
    const result = await dispatchAlert(event, {
      emailRecipients,
      slackWebhookUrl: client.slack_webhook_url,
      businessName: client.business_name,
      dashboardUrl,
    });
    if (result.emailsSent > 0 || result.slackSent) {
      dispatched += 1;
      newLastFired[event.type] = new Date().toISOString();
    }
  }

  // 8. Update debounce map.
  if (dispatched > 0) {
    await supabase
      .from('clients')
      .update({ alerts_last_fired_at: newLastFired })
      .eq('id', client.id);
  }

  return {
    events,
    dispatched,
    suppressed: events.length - filtered.length,
  };
}
