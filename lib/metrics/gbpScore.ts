/**
 * GBP Optimization Scorecard.
 *
 * Turns the Google Business Profile signals we capture (gbp_signals) into a
 * 0–100 completeness/optimization score plus per-dimension findings, so the
 * Pulse+ dashboard can surface concrete "fix this" GBP actions — the same
 * lever the AI Coach now leads with for reach-bound businesses.
 *
 * Pure + testable (scripts/verify-gbp-score.ts). No I/O.
 *
 * Provenance caveats baked in (mirrors lib/google/gbpSignalProvenance):
 *   - photos_count is CAPPED at 10 by the Places API — a value at the cap
 *     means "10 or more", NOT thin. Only a genuinely low count is a gap.
 *   - the editorial summary is GOOGLE-authored and absent for most
 *     businesses; the owner cannot add one, so it is NOT scored.
 *   - primary_type is Google's coarse type taxonomy, not the owner's GBP
 *     categories — we score category BREADTH (how many types are present),
 *     not whether a specific category is "right".
 */

import { PLACES_PHOTOS_CAP } from '@/lib/google/gbpSignalProvenance';

export type GbpScoreInput = {
  rating: number | null;
  reviewCount: number | null;
  primaryType: string | null;
  types: string[] | null;
  businessStatus: string | null;
  photosCount: number | null;
  hoursSummary: string[] | null;
};

export type GbpScoreDimension = {
  key: 'categories' | 'photos' | 'reviews' | 'rating' | 'hours' | 'status';
  label: string;
  /** good = optimized; gap = a concrete, fixable shortfall; unknown =
   *  we lack the data to judge (don't present as a gap). */
  status: 'good' | 'gap' | 'unknown';
  /** weight in the composite (only good/gap dimensions count). */
  weight: number;
  detail: string;
};

export type GbpScoreResult = {
  /** 0–100 across the dimensions we can judge. null when none are judgeable
   *  (no GBP signals at all). */
  score: number | null;
  dimensions: GbpScoreDimension[];
};

/** Review-count floor below which prominence is a clear gap for a local
 *  service business. Above it, reviews aren't the bottleneck (velocity is,
 *  which the coach handles separately). */
const REVIEW_FLOOR = 25;
/** Photo count below which the listing reads as under-populated. The cap is
 *  10, so anything at/above it is treated as sufficient (we can't see more). */
const PHOTOS_FLOOR = 5;

export function scoreGbpProfile(input: GbpScoreInput): GbpScoreResult {
  const dims: GbpScoreDimension[] = [];

  // Categories — breadth (primary + secondaries). More categories = more
  // query surfaces. We score the count, not which ones.
  const typeCount = input.types?.length ?? (input.primaryType ? 1 : 0);
  if (!input.primaryType && typeCount === 0) {
    dims.push({ key: 'categories', label: 'Categories', status: 'unknown', weight: 0, detail: 'No category data on the listing.' });
  } else if (typeCount >= 3) {
    dims.push({ key: 'categories', label: 'Categories', status: 'good', weight: 2, detail: `${typeCount} categories set — good relevance breadth.` });
  } else {
    dims.push({ key: 'categories', label: 'Categories', status: 'gap', weight: 2, detail: `Only ${typeCount} categor${typeCount === 1 ? 'y' : 'ies'} — add relevant secondary categories to widen query coverage.` });
  }

  // Photos — respect the 10-cap: at/above cap = sufficient (can't tell more).
  if (input.photosCount == null) {
    dims.push({ key: 'photos', label: 'Photos', status: 'unknown', weight: 0, detail: 'Photo count unavailable.' });
  } else if (input.photosCount >= PHOTOS_FLOOR) {
    const display = input.photosCount >= PLACES_PHOTOS_CAP ? `${PLACES_PHOTOS_CAP}+` : String(input.photosCount);
    dims.push({ key: 'photos', label: 'Photos', status: 'good', weight: 1, detail: `${display} photos on the listing.` });
  } else {
    dims.push({ key: 'photos', label: 'Photos', status: 'gap', weight: 1, detail: `Only ${input.photosCount} photo${input.photosCount === 1 ? '' : 's'} — add completed-job photos to lift engagement.` });
  }

  // Reviews — count as a prominence floor.
  if (input.reviewCount == null) {
    dims.push({ key: 'reviews', label: 'Reviews', status: 'unknown', weight: 0, detail: 'Review count unavailable.' });
  } else if (input.reviewCount >= REVIEW_FLOOR) {
    dims.push({ key: 'reviews', label: 'Reviews', status: 'good', weight: 2, detail: `${input.reviewCount} reviews — solid prominence base.` });
  } else {
    dims.push({ key: 'reviews', label: 'Reviews', status: 'gap', weight: 2, detail: `${input.reviewCount} reviews — below the ${REVIEW_FLOOR}-review floor; prioritize review generation.` });
  }

  // Rating quality.
  if (input.rating == null) {
    dims.push({ key: 'rating', label: 'Rating', status: 'unknown', weight: 0, detail: 'Rating unavailable.' });
  } else if (input.rating >= 4.3) {
    dims.push({ key: 'rating', label: 'Rating', status: 'good', weight: 1, detail: `${input.rating.toFixed(1)}★ — competitive.` });
  } else {
    dims.push({ key: 'rating', label: 'Rating', status: 'gap', weight: 1, detail: `${input.rating.toFixed(1)}★ — below 4.3; sentiment is a drag on pack placement.` });
  }

  // Hours present.
  const hasHours = (input.hoursSummary?.length ?? 0) > 0;
  dims.push(
    hasHours
      ? { key: 'hours', label: 'Hours', status: 'good', weight: 1, detail: 'Business hours are set.' }
      : { key: 'hours', label: 'Hours', status: 'gap', weight: 1, detail: 'No business hours set — add them; missing hours suppress local intent.' }
  );

  // Operational status.
  if (!input.businessStatus) {
    dims.push({ key: 'status', label: 'Status', status: 'unknown', weight: 0, detail: 'Status unavailable.' });
  } else if (input.businessStatus === 'OPERATIONAL') {
    dims.push({ key: 'status', label: 'Status', status: 'good', weight: 2, detail: 'Listing is OPERATIONAL.' });
  } else {
    dims.push({ key: 'status', label: 'Status', status: 'gap', weight: 2, detail: `Listing status is ${input.businessStatus} — fix immediately; a non-operational status removes it from the pack.` });
  }

  // Composite — weighted share of judgeable dimensions that are 'good'.
  const judged = dims.filter((d) => d.status !== 'unknown');
  const totalWeight = judged.reduce((a, d) => a + d.weight, 0);
  const goodWeight = judged
    .filter((d) => d.status === 'good')
    .reduce((a, d) => a + d.weight, 0);
  const score = totalWeight === 0 ? null : Math.round((goodWeight / totalWeight) * 100);

  return { score, dimensions: dims };
}
