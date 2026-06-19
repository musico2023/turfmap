/**
 * SINGLE SOURCE OF TRUTH for the provenance + caveats of every
 * Google-sourced signal the TurfMap AI surfaces (AI Coach, Visibility
 * Roadmap) cite about a business.
 *
 * WHY THIS EXISTS — three separate client-facing FALSE claims shipped
 * because an API's *output* was treated as *ground truth*:
 *   1. GBP "unverified, no phone/address"  — DFS local_pack returns no NAP
 *   2. "10 photos, critically thin"        — Places caps photos at 10
 *   3. "category is general_contractor"    — Places type taxonomy != GBP category
 *
 * Each entry records what the source API actually GUARANTEES and the
 * caveat any consumer (especially an LLM prompt) must respect.
 *
 * RULE FOR THE NEXT PERSON: before citing a new gbp_signals / NAP field
 * in any AI prompt, add it here first. If it's `caveated`, the consuming
 * prompt MUST contain its `promptGuardMarker` — scripts/verify-gbp-signal-
 * provenance.ts enforces that, so the build fails if a guardrail is
 * removed or a caveated field is added without one.
 *
 * Consumers wired to this file:
 *   - lib/anthropic/prompts/turfCoach.ts  (AI Coach prompt + formatPhotosCount)
 *   - lib/google/places.ts                (photosCount cap)
 *   - lib/citations/dfsChecker.ts         (google_business authoritative NAP)
 *   - lib/ai/roadmapGenerator.ts          (NAP "missing" calibration)
 */

/** Google Places Place Details returns AT MOST this many photos, so a
 *  stored photos_count equal to this means "N or more" — NOT the true
 *  count. The one place this cap is defined. */
export const PLACES_PHOTOS_CAP = 10;

export type SignalSafety = 'safe' | 'caveated';

export type GbpSignalProvenance = {
  /** Human label for the signal. */
  field: string;
  /** Where the value comes from. */
  source: string;
  /** What that source actually guarantees. */
  guarantee: string;
  /** 'safe' = the raw value may be cited as-is. 'caveated' = it can
   *  mislead and REQUIRES a guard in any prompt that cites it. */
  safety: SignalSafety;
  /** The trap, for 'caveated' fields. null for 'safe'. */
  caveat: string | null;
  /** A stable substring that MUST appear in TURF_COACH_SYSTEM_PROMPT for
   *  every 'caveated' field — the regression marker the verify script
   *  checks. null for 'safe' fields. */
  promptGuardMarker: string | null;
};

export const GBP_SIGNAL_PROVENANCE: readonly GbpSignalProvenance[] = [
  {
    field: 'rating',
    source: 'Google Places Place Details — rating',
    guarantee: 'Accurate average star rating. Not capped.',
    safety: 'safe',
    caveat: null,
    promptGuardMarker: null,
  },
  {
    field: 'reviewCount (user_ratings_total)',
    source: 'Google Places Place Details — userRatingCount',
    guarantee: 'Accurate total review count. Not capped.',
    safety: 'safe',
    caveat: null,
    promptGuardMarker: null,
  },
  {
    field: 'businessStatus',
    source: 'Google Places Place Details — businessStatus',
    guarantee:
      'Accurate enum (OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY). Rendered only when present.',
    safety: 'safe',
    caveat: null,
    promptGuardMarker: null,
  },
  {
    field: 'hours',
    source:
      'Google Places Place Details — regularOpeningHours.weekdayDescriptions',
    guarantee:
      'Accurate regular hours. Rendered only when present — absence is never asserted.',
    safety: 'safe',
    caveat: null,
    promptGuardMarker: null,
  },
  {
    field: 'primaryType / types',
    source: 'Google Places Place Details — primaryType / types',
    guarantee: "Google's COARSE place-type taxonomy (e.g. general_contractor).",
    safety: 'caveated',
    caveat:
      'NOT the GBP categories the owner selected — Google does not expose those via the Places API. A kitchen remodeler appears as general_contractor. Never assert the current GBP category or recommend adding one from this signal.',
    promptGuardMarker: 'NOT the GBP categories',
  },
  {
    field: 'photosCount',
    source: 'Google Places Place Details — photos.length',
    guarantee: `min(actualPhotos, ${PLACES_PHOTOS_CAP}); the API returns at most ${PLACES_PHOTOS_CAP} photos.`,
    safety: 'caveated',
    caveat: `A value of ${PLACES_PHOTOS_CAP} means "≥ ${PLACES_PHOTOS_CAP}" (capped), not the true count. Never call photos thin or recommend adding photos off a capped value. Render via formatPhotosCount.`,
    promptGuardMarker: 'capped at 10',
  },
  {
    field: 'editorialSummary',
    source: 'Google Places Place Details — editorialSummary',
    guarantee: 'A Google-AUTHORED description, present for only some places.',
    safety: 'caveated',
    caveat:
      'Absent for most businesses and the owner CANNOT add one. Its absence is normal — never flag a missing editorial summary or recommend writing one.',
    promptGuardMarker: 'absence is NORMAL',
  },
  {
    field: 'napMissingDirectory',
    source:
      'DFS NAP audit — findings.missing (site:-search / local_pack probe)',
    guarantee:
      'Whether the automated probe FOUND / DID-NOT-FIND a listing — not real presence/absence.',
    safety: 'caveated',
    caveat:
      'Name variants + unindexed pages cause false "missing". Frame as "confirm, then claim if absent"; never assert flat absence from a major consumer directory for an established business.',
    promptGuardMarker: 'confidence calibration',
  },
] as const;
