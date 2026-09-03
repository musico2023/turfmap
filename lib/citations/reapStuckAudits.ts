/**
 * Stuck NAP-audit reaper.
 *
 * The DFS checker (lib/citations/dfsChecker.ts) is synchronous: insert a
 * `pending` row, run ~9 SERP probes in 5-9s, stamp `complete` (or `failed`
 * on a thrown error) in the same request. That design has no recovery path
 * for the one case it can't catch — the process dying mid-run. A function
 * timeout, an OOM, or a deploy rolling the instance leaves the row at
 * `pending` forever with a null error_message, and nothing sweeps it.
 *
 * Why that costs money: both deliverable loaders
 * (lib/audit/auditDataLoaders.loadNapFindingsSummary and
 * generateAndStoreRoadmapPdf.loadNapFindingsForPdf) read the MOST RECENT
 * audit row for the client and bail when `findings` is null. So one stuck
 * row means the buyer's AI Coach playbook and Roadmap PDF ship with an
 * empty NAP section — silently, with no error anywhere. Worse, passive
 * re-audit callers (audit-init bootstrap, AI-Coach self-heal) treat
 * `pending` as "recent audit already exists" (autoAudit.ts step 3) and
 * skip for the full 30-day AUDIT_REFRESH_WINDOW_MS, so the location can't
 * heal itself either.
 *
 * Production evidence (2026-09-03): 35 rows stuck at `pending`, all
 * trigger_source='scan', none carrying an error_message, oldest 71 days.
 * Three belong to `one_time` buyers — people who paid $99-$197 and got a
 * deliverable with no NAP findings. The stuck rate climbed from 0% in late
 * June to 8-19% through August, so this is getting worse, not settling.
 *
 * What the sweep does, per stuck row:
 *   1. Stamps it `failed` with a REAP_ERROR_PREFIX message. `failed` is
 *      outside autoAudit's ['pending','running','complete'] recent-audit
 *      filter, so this alone unblocks passive re-audit for the location.
 *   2. Immediately retries once via maybeRunNapAudit(force). A DFS audit
 *      is ~$0.02-0.09, so healing the deliverable is worth far more than
 *      it costs — and the retry runs whatever NAP_AUDIT_PROVIDER is
 *      currently set to, which is how the four legacy BrightLocal
 *      `running` rows (112+ days old, BL Data API long gone) finally get
 *      real findings.
 *
 * Runaway protection: a location that keeps dying mid-audit would burn DFS
 * budget on every tick. Prior reaps are counted per location over
 * REAP_RETRY_LOOKBACK_MS; past MAX_REAP_RETRIES_PER_LOCATION the row is
 * still marked `failed` (the unblock is free) but the retry is withheld
 * and the operator gets one Slack ping naming the location. That turns a
 * silent recurring failure into a visible one.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { maybeRunNapAudit } from '@/lib/brightlocal/autoAudit';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';
import type { ClientRow, NapAuditRow } from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

/** How long a DFS audit may sit unfinished before it counts as dead.
 *  The checker itself takes 5-9s and the routes that call it cap at
 *  maxDuration 60-300s, so nothing legitimate is still in flight at 15
 *  minutes. */
export const DFS_STUCK_AFTER_MS = 15 * 60 * 1000;

/** BrightLocal audits were asynchronous — the row sat at `running` while
 *  BL's fan-out resolved, finalized lazily by maybeFinalizeNapAudit on a
 *  later user action. A full day is well past any real finalize window
 *  while still catching the legacy rows that will never finalize. Also
 *  the fallback for rows with a null/unknown provider. */
export const BRIGHTLOCAL_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

/** Retries allowed per location inside REAP_RETRY_LOOKBACK_MS before the
 *  reaper stops spending on it and escalates to the operator instead. */
export const MAX_REAP_RETRIES_PER_LOCATION = 2;

/** Window over which prior reaps are counted against a location. */
export const REAP_RETRY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Max stuck rows examined per tick. */
export const REAP_SCAN_LIMIT = 100;

/** Max re-audits fired per tick. Each costs one DFS audit and ~5-9s of
 *  wall clock; 10 keeps the cron comfortably inside maxDuration 300 even
 *  when every retry runs long. Rows over budget are still marked failed
 *  and get their retry on the next tick. */
export const RETRY_BUDGET_PER_TICK = 10;

/** Marker prefix on error_message for rows this sweep failed, so a reaped
 *  row is distinguishable from a genuine checker error — both when
 *  counting prior reaps and when an operator reads the table. */
export const REAP_ERROR_PREFIX = '[reaped]';

/** The audit statuses that can be stuck. Mirrors the partial index from
 *  migration 0005 (`nap_audits_status_idx`). */
export const REAPABLE_STATUSES = ['pending', 'running'] as const;

/** Threshold for a row, chosen by the provider that created it. */
export function stuckThresholdMs(provider: string | null | undefined): number {
  return provider === 'dfs' ? DFS_STUCK_AFTER_MS : BRIGHTLOCAL_STUCK_AFTER_MS;
}

/** Group key for per-location reap counting. Legacy rows predate
 *  client_locations and carry a null location_id; those key off the
 *  client alone, which matches how maybeRunNapAudit resolves them (null
 *  locationId → the client's primary location). */
export function reapKey(
  clientId: string,
  locationId: string | null | undefined
): string {
  return `${clientId}:${locationId ?? 'primary'}`;
}

export type ReapCandidate = Pick<
  NapAuditRow,
  'id' | 'client_id' | 'location_id' | 'provider' | 'status' | 'created_at'
>;

export type ReapAction =
  /** Still inside its provider's in-flight window — not stuck yet. */
  | { action: 'leave'; reason: string }
  /** Mark failed (unblocks re-audit) but don't spend a retry. */
  | { action: 'fail_only'; reason: string; escalate: boolean }
  /** Mark failed, then immediately re-run the audit. */
  | { action: 'fail_and_retry' };

/**
 * Pure decision for one candidate row. Split out from the sweep so the
 * thresholds, the runaway cap, and the budget interaction are testable
 * without a database (scripts/verify-stuck-audit-reaper.ts).
 */
export function decideReap(
  candidate: ReapCandidate,
  ctx: {
    nowMs: number;
    /** Reaps already recorded for this location in the lookback window. */
    priorReapsForLocation: number;
    /** Retries left in this tick's budget. */
    retryBudgetRemaining: number;
  }
): ReapAction {
  const createdMs = candidate.created_at
    ? Date.parse(candidate.created_at)
    : NaN;
  if (!Number.isFinite(createdMs)) {
    // created_at is nullable on nap_audits and could in principle be
    // unparseable. Either way we can't measure an age, so we can't tell a
    // dead row from a live one — mark it failed (free, and it unblocks
    // re-audit) but don't spend a retry on a row we can't reason about.
    return {
      action: 'fail_only',
      reason: 'missing or unparseable created_at',
      escalate: false,
    };
  }

  const ageMs = ctx.nowMs - createdMs;
  const threshold = stuckThresholdMs(candidate.provider);
  if (ageMs < threshold) {
    return { action: 'leave', reason: 'still inside the in-flight window' };
  }

  if (ctx.priorReapsForLocation >= MAX_REAP_RETRIES_PER_LOCATION) {
    // This location has died mid-audit repeatedly. Stop paying DFS to
    // rediscover that; make it the operator's problem instead.
    return {
      action: 'fail_only',
      reason: `reaped ${ctx.priorReapsForLocation}x in the last ${Math.round(
        REAP_RETRY_LOOKBACK_MS / (24 * 60 * 60 * 1000)
      )}d — retry withheld`,
      escalate: true,
    };
  }

  if (ctx.retryBudgetRemaining <= 0) {
    return {
      action: 'fail_only',
      reason: 'retry budget spent this tick — retries next tick',
      escalate: false,
    };
  }

  return { action: 'fail_and_retry' };
}

/** Human-readable age, for the error_message stamped on a reaped row. */
export function formatAge(ms: number): string {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 48 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

/** The error_message written onto a reaped row. Always starts with
 *  REAP_ERROR_PREFIX so prior-reap counting can find it. */
export function reapErrorMessage(
  status: string,
  ageMs: number,
  detail: string
): string {
  return `${REAP_ERROR_PREFIX} stuck in '${status}' for ${formatAge(
    ageMs
  )} with no result — the audit process died mid-run (function timeout, OOM, or a deploy rolling the instance). ${detail}`;
}

export type ReapSweepResult = {
  /** Stuck-status rows examined. */
  scanned: number;
  /** Rows left alone — still inside their in-flight window. */
  left: number;
  /** Rows stamped `failed` by this sweep. */
  reaped: number;
  /** Re-audits fired. */
  retried: number;
  /** Re-audits that produced a fresh audit row. */
  healed: number;
  /** Locations that hit the runaway cap and got an operator ping. */
  escalated: number;
  errors: string[];
};

/**
 * Sweep stuck NAP audits. Never throws — every failure is collected into
 * `errors` so one bad row can't abort the tick.
 */
export async function reapStuckNapAudits(
  supabase: SupabaseLike,
  opts: { nowMs?: number; retryBudget?: number; scanLimit?: number } = {}
): Promise<ReapSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const scanLimit = opts.scanLimit ?? REAP_SCAN_LIMIT;
  let retryBudgetRemaining = opts.retryBudget ?? RETRY_BUDGET_PER_TICK;

  const result: ReapSweepResult = {
    scanned: 0,
    left: 0,
    reaped: 0,
    retried: 0,
    healed: 0,
    escalated: 0,
    errors: [],
  };

  // Oldest first: the longest-broken deliverables heal first, and a
  // backlog larger than the budget drains deterministically.
  const { data: candidates, error: selErr } = await supabase
    .from('nap_audits')
    .select('id, client_id, location_id, provider, status, created_at')
    .in('status', REAPABLE_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })
    .limit(scanLimit)
    .returns<ReapCandidate[]>();

  if (selErr) {
    result.errors.push(`candidate select failed: ${selErr.message}`);
    return result;
  }
  if (!candidates || candidates.length === 0) return result;
  result.scanned = candidates.length;

  // Prior reaps per location over the lookback window, counted in one
  // query and grouped in memory (the volume is small — reaps are rare by
  // design, and a location that produced many is exactly the one we're
  // about to stop retrying).
  const priorReaps = new Map<string, number>();
  const lookbackSince = new Date(nowMs - REAP_RETRY_LOOKBACK_MS).toISOString();
  const { data: priorRows, error: priorErr } = await supabase
    .from('nap_audits')
    .select('client_id, location_id')
    .eq('status', 'failed')
    .gte('created_at', lookbackSince)
    .like('error_message', `${REAP_ERROR_PREFIX}%`)
    .returns<Pick<NapAuditRow, 'client_id' | 'location_id'>[]>();

  if (priorErr) {
    // Without the history we can't enforce the runaway cap safely, so
    // fail closed: mark rows failed (free, and the unblock is the point)
    // but spend nothing on retries this tick.
    result.errors.push(
      `prior-reap lookup failed: ${priorErr.message} — retries withheld this tick`
    );
    retryBudgetRemaining = 0;
  } else {
    for (const row of priorRows ?? []) {
      const key = reapKey(row.client_id, row.location_id);
      priorReaps.set(key, (priorReaps.get(key) ?? 0) + 1);
    }
  }

  for (const candidate of candidates) {
    const key = reapKey(candidate.client_id, candidate.location_id);
    const decision = decideReap(candidate, {
      nowMs,
      priorReapsForLocation: priorReaps.get(key) ?? 0,
      retryBudgetRemaining,
    });

    if (decision.action === 'leave') {
      result.left++;
      continue;
    }

    const createdMs = candidate.created_at
      ? Date.parse(candidate.created_at)
      : NaN;
    const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : 0;
    const willRetry = decision.action === 'fail_and_retry';
    const detail = willRetry
      ? 'Reaped by the reap-stuck-audits cron; a fresh audit was queued immediately.'
      : `Reaped by the reap-stuck-audits cron (${decision.reason}).`;

    const { data: updated, error: updErr } = await supabase
      .from('nap_audits')
      .update({
        status: 'failed',
        error_message: reapErrorMessage(candidate.status, ageMs, detail),
        completed_at: new Date(nowMs).toISOString(),
      })
      .eq('id', candidate.id)
      // Only transition a row that's STILL stuck. The status filter is
      // the race guard: a long-running audit can finish between our
      // select and this update, and overwriting its real result with a
      // failure would be strictly worse than the bug we're fixing.
      .in('status', REAPABLE_STATUSES as unknown as string[])
      .select('id')
      .returns<{ id: string }[]>();

    if (updErr) {
      result.errors.push(`audit ${candidate.id} update failed: ${updErr.message}`);
      continue;
    }
    if (!updated || updated.length === 0) {
      // Lost the race — the original run landed a real result. Count it
      // as left alone so we neither claim a reap nor spend a DFS retry
      // re-auditing a location that just succeeded.
      result.left++;
      continue;
    }
    result.reaped++;
    // Count this reap immediately so several stuck rows on the SAME
    // location in one tick can't each spend a retry.
    priorReaps.set(key, (priorReaps.get(key) ?? 0) + 1);

    if (decision.action === 'fail_only') {
      if (decision.escalate) {
        result.escalated++;
        await pingOperator(supabase, candidate, decision.reason, result);
      }
      continue;
    }

    retryBudgetRemaining--;
    result.retried++;
    try {
      const run = await maybeRunNapAudit(
        supabase,
        candidate.client_id,
        null,
        candidate.location_id,
        'cron',
        { force: true }
      );
      if (run.ran) result.healed++;
      else if (run.reason) {
        result.errors.push(`audit ${candidate.id} retry skipped: ${run.reason}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`audit ${candidate.id} retry threw: ${msg}`);
    }
  }

  return result;
}

/** Fail-soft operator ping for a location that keeps dying mid-audit. */
async function pingOperator(
  supabase: SupabaseLike,
  candidate: ReapCandidate,
  reason: string,
  result: ReapSweepResult
): Promise<void> {
  let name = candidate.client_id;
  try {
    const { data } = await supabase
      .from('clients')
      .select('business_name')
      .eq('id', candidate.client_id)
      .maybeSingle<Pick<ClientRow, 'business_name'>>();
    if (data?.business_name) name = data.business_name;
  } catch {
    // fall back to the id — the ping still points somewhere actionable
  }
  try {
    await postOperatorSlack({
      text: `⚠️ NAP audit keeps dying mid-run for ${name} (location ${
        candidate.location_id ?? 'primary'
      }): ${reason}. Their AI Coach + Roadmap PDF will render an empty NAP section until this is fixed. Check the location's NAP completeness and the DFS checker logs.`,
    });
  } catch {
    result.errors.push(
      `escalation Slack ping failed for client ${candidate.client_id}`
    );
  }
}
