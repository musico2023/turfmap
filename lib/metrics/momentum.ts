/**
 * Momentum — change in TurfScore between consecutive scans for the
 * same client.
 *
 * Formula: current_scan.turf_score − previous_scan.turf_score
 *
 *   first scan ever                → null
 *   current 35, previous 20        → +15  ("Strong territorial expansion")
 *   current 50, previous 50        → 0    ("Holding steady")
 *   current 30, previous 45        → -15  ("Significant pullback")
 *
 * Returns null when there's no previous scan to compare against
 * (renders as "—" with the "Momentum unlocks after your next re-scan"
 * caption on a brand-new client's first scan).
 *
 * Persistence model: stored as `scans.momentum` so the dashboard +
 * AI Coach can read it without re-querying the prior scan. Computed
 * at scan-completion time and on backfill.
 */

export function momentum(
  currentTurfScore: number | null,
  previousTurfScore: number | null
): number | null {
  if (
    currentTurfScore === null ||
    currentTurfScore === undefined ||
    previousTurfScore === null ||
    previousTurfScore === undefined
  ) {
    return null;
  }
  return Math.round(currentTurfScore - previousTurfScore);
}

/** Categorical caption for a momentum value (used by dashboard + AI Coach). */
export function momentumCaption(m: number | null): string {
  if (m === null || m === undefined) {
    return 'Momentum unlocks after your next re-scan';
  }
  if (m >= 10) return 'Strong territorial expansion';
  if (m >= 1) return 'Growing';
  if (m === 0) return 'Holding steady';
  if (m >= -9) return 'Contracting — investigate';
  return 'Significant pullback — urgent review';
}
