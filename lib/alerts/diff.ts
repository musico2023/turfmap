/**
 * Alert diff helpers — pure functions that compare two scans (or a
 * scan + its prior history) and produce a list of typed alert
 * events. Dispatching is done elsewhere (lib/alerts/dispatch.ts);
 * this module is responsible only for "what changed" detection.
 *
 * Pure-function design lets the caller decide which alert types to
 * emit (driven by clients.alert_prefs) and lets us unit-test the
 * detection logic without mocking Supabase.
 */

import type {
  AlertPrefs,
  CitationDirectoryEntry,
  ScanPointRow,
  ScanRow,
} from '@/lib/supabase/types';

export type AlertType =
  | 'score_movement'
  | 'competitor_entries'
  | 'momentum_reversal'
  | 'cell_changes';

export type AlertEvent =
  | {
      type: 'score_movement';
      direction: 'up' | 'down';
      delta: number;
      newScore: number;
      priorScore: number;
    }
  | {
      type: 'competitor_entries';
      newCompetitors: string[];
      priorCompetitors: string[];
    }
  | {
      type: 'momentum_reversal';
      from: 'positive' | 'negative';
      to: 'positive' | 'negative';
      momentum: number;
    }
  | {
      type: 'cell_changes';
      cellsImproved: number;
      cellsDegraded: number;
      avgRankDelta: number;
    };

type DiffInput = {
  current: Pick<ScanRow, 'turf_score' | 'momentum'>;
  prior: Pick<ScanRow, 'turf_score' | 'momentum'> | null;
  /** Cells from the current scan keyed by "x,y" → rank. */
  currentCells: Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank'>[];
  /** Cells from the prior scan, same shape. Empty array on first scan. */
  priorCells: Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank'>[];
  /** Competitor names observed across the current scan's local-pack
   *  results. Caller computes from scan_points.competitors. */
  currentCompetitorNames: string[];
  /** Competitor names from the prior scan. Empty on first scan. */
  priorCompetitorNames: string[];
};

/**
 * Run every alert detector against (current, prior) and return the
 * list of events that fired. Caller filters by AlertPrefs to decide
 * which to dispatch, and is responsible for the per-alert-type
 * debounce window (alerts_last_fired_at).
 */
export function diffScans(input: DiffInput): AlertEvent[] {
  const events: AlertEvent[] = [];

  if (input.prior) {
    const scoreEvent = detectScoreMovement(input);
    if (scoreEvent) events.push(scoreEvent);

    const momEvent = detectMomentumReversal(input);
    if (momEvent) events.push(momEvent);

    const cellEvent = detectCellChanges(input);
    if (cellEvent) events.push(cellEvent);
  }

  // Competitor-entries fires regardless of prior scan existence —
  // first-scan results count any new brand as "entry" against an
  // empty baseline. Caller can suppress by checking input.prior or
  // by having the alert_prefs default to ON only after first scan.
  const compEvent = detectCompetitorEntries(input);
  if (compEvent) events.push(compEvent);

  return events;
}

/**
 * Filter a list of events by the client's AlertPrefs. score_movement
 * also gates on the configured threshold.
 */
export function applyAlertPrefs(
  events: AlertEvent[],
  prefs: AlertPrefs
): AlertEvent[] {
  return events.filter((e) => {
    switch (e.type) {
      case 'score_movement':
        return (
          prefs.score_movement_email &&
          Math.abs(e.delta) >= prefs.score_movement_threshold
        );
      case 'competitor_entries':
        return (
          prefs.competitor_entries_email && e.newCompetitors.length > 0
        );
      case 'momentum_reversal':
        return prefs.momentum_reversal_email;
      case 'cell_changes':
        return (
          prefs.cell_changes_email &&
          e.cellsImproved + e.cellsDegraded > 0
        );
    }
  });
}

// ─── detectors ─────────────────────────────────────────────────────────────

function detectScoreMovement(input: DiffInput): AlertEvent | null {
  const newScore = numberOrNull(input.current.turf_score);
  const priorScore = numberOrNull(input.prior?.turf_score ?? null);
  if (newScore == null || priorScore == null) return null;
  const delta = newScore - priorScore;
  if (delta === 0) return null;
  return {
    type: 'score_movement',
    direction: delta > 0 ? 'up' : 'down',
    delta,
    newScore,
    priorScore,
  };
}

function detectMomentumReversal(input: DiffInput): AlertEvent | null {
  const cur = numberOrNull(input.current.momentum);
  const prior = numberOrNull(input.prior?.momentum ?? null);
  if (cur == null || prior == null) return null;
  if (cur === 0 || prior === 0) return null;
  const curSign: 'positive' | 'negative' = cur > 0 ? 'positive' : 'negative';
  const priorSign: 'positive' | 'negative' =
    prior > 0 ? 'positive' : 'negative';
  if (curSign === priorSign) return null;
  return {
    type: 'momentum_reversal',
    from: priorSign,
    to: curSign,
    momentum: cur,
  };
}

function detectCellChanges(input: DiffInput): AlertEvent | null {
  if (input.priorCells.length === 0) return null;
  const priorMap = new Map<string, number | null>();
  for (const c of input.priorCells) {
    priorMap.set(`${c.grid_x},${c.grid_y}`, c.rank);
  }
  let cellsImproved = 0;
  let cellsDegraded = 0;
  let totalRankDelta = 0;
  let comparedCells = 0;
  for (const c of input.currentCells) {
    const key = `${c.grid_x},${c.grid_y}`;
    const prior = priorMap.get(key);
    if (prior === undefined) continue;
    const cur = c.rank ?? null;
    if (cur === prior) continue;
    // Treat "absent" (null rank, > top-of-pack) as worst — rank 100
    // sentinel. Improvement is rank going DOWN (lower number = better).
    const curEff = cur ?? 100;
    const priorEff = prior ?? 100;
    const rankDelta = curEff - priorEff;
    totalRankDelta += rankDelta;
    comparedCells += 1;
    if (rankDelta < 0) cellsImproved += 1;
    else cellsDegraded += 1;
  }
  if (cellsImproved + cellsDegraded === 0) return null;
  return {
    type: 'cell_changes',
    cellsImproved,
    cellsDegraded,
    avgRankDelta: comparedCells === 0 ? 0 : totalRankDelta / comparedCells,
  };
}

function detectCompetitorEntries(input: DiffInput): AlertEvent | null {
  const priorSet = new Set(
    input.priorCompetitorNames.map((s) => s.toLowerCase().trim())
  );
  const newOnes = input.currentCompetitorNames.filter(
    (name) => !priorSet.has(name.toLowerCase().trim())
  );
  if (newOnes.length === 0 && input.priorCompetitorNames.length > 0) {
    return null;
  }
  if (newOnes.length === 0) return null;
  return {
    type: 'competitor_entries',
    newCompetitors: newOnes,
    priorCompetitors: input.priorCompetitorNames,
  };
}

function numberOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ─── debounce helpers ─────────────────────────────────────────────────────

/** Default 6-hour debounce per alert type. Same alert won't re-fire
 *  for the same client inside this window — keeps a flapping score
 *  from generating 6+ emails in a single day. */
export const DEBOUNCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export function shouldDebounce(
  type: AlertType,
  lastFiredAt: Record<string, string> | null,
  now: number = Date.now()
): boolean {
  const ts = lastFiredAt?.[type];
  if (!ts) return false;
  const last = new Date(ts).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < DEBOUNCE_WINDOW_MS;
}

// ─── helper for caller: extract competitor names from scan_points ─────────

/**
 * Pulls the union of competitor names observed across a scan's
 * scan_points.competitors arrays. Used by the alert pipeline to
 * compute the competitor-entries diff.
 */
export function extractCompetitorNames(
  points: Array<Pick<ScanPointRow, 'competitors'>>
): string[] {
  const set = new Set<string>();
  for (const p of points) {
    const arr = p.competitors as
      | Array<{ name?: string | null }>
      | null
      | undefined;
    if (!arr) continue;
    for (const c of arr) {
      if (c?.name) set.add(c.name.trim());
    }
  }
  return Array.from(set);
}

// Re-export for callers building dispatch payloads.
export type { CitationDirectoryEntry };
