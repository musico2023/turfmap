/**
 * Convert the raw Average Map Rank (AMR, lower-is-better, range 1..20) that
 * we store in `scans.turf_score` into the 0–100 sales-friendly display score
 * shown on the dashboard, PDF, and trend chart. Higher = better, like every
 * conventional score people expect.
 *
 *   AMR 1.0  → display 95  (you're #1 in every cell)
 *   AMR 3.0  → display 85
 *   AMR 16.8 → display 16  (Kidcrew's current state)
 *   AMR 20.0 → display 0   (invisible everywhere)
 *
 * Formula: 100 − 5 × AMR, clamped to [0, 100], integer.
 *
 * Keeping the database column as AMR means historical data stays meaningful
 * and the DB stays decoupled from display choices. This helper is the single
 * point of conversion for every UI surface.
 */

export function turfScoreDisplay(amr: number | null): number | null {
  if (amr === null) return null;
  const raw = 100 - 5 * amr;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
