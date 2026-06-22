# Service-Area Business (SAB) Support Across All Intakes — Design

**Date:** 2026-06-22
**Status:** Approved (Approach A), pending spec review
**Origin:** A bathtub-refinishing prospect (Anew Bathtub Repair & Refinishing, Reno NV) is a service-area business — Google hides its street address. The current intakes are address-centric: the agency form's manual mode requires a geocodable address, the public scan endpoints require an `address` string, and the NAP citation audit skips entirely without full structured NAP. SABs are a large share of home services, so they must be a first-class intake case.

## Principle

**Coordinates are the requirement; a street address is optional.** Accept coordinates from the Google map pin (present for SABs) or a geocoded city; never block on a street address. Phone is *encouraged* — it's what lets a found directory listing classify as `matched` vs merely `found` — but never required.

## Scope

Every intake surface, not just the agency form:

**Frontend**
- `components/turfmap/ClientCreateForm.tsx` (agency add-client — GBP + manual)
- `components/marketing/scan/ScanIntakeForm.tsx`, `components/free-score-now/QuizFlow.tsx` (public free-scan landers — GBP-first)
- `app/yourmap` (cold-email lander), onboarding (`OnboardingWizard` / `CitationOnboardingForm`)

**Backend**
- `app/api/clients/route.ts`
- `app/api/score/preview-init/route.ts`, `app/api/score/unlock-init/route.ts`
- `app/api/scan/checkout/init/route.ts`
- `app/api/yourmap/coldscan-fulfill/route.ts`
- `app/api/onboarding/[publicId]/route.ts`
- `app/api/places/resolve/route.ts` (shared resolver — verify it never errors when Google omits the address)

**Shared logic**
- `lib/brightlocal/autoAudit.ts` + a new `locationToCitationProfile` builder (the audit gate)

## Design

### 1. Shared backend rule — "coordinates OR geocodable address," not "address required"

Each intake endpoint currently requires a freeform `address` (`z.string().min(4)`) and treats `latitude`/`longitude` as optional. Flip every one of them to:

- Require **either** `(latitude AND longitude)` **or** a geocodable `address`/city — at least one source of a center point.
- `street_address`, `postcode` remain optional/nullable (already are on most).

The GBP pick supplies `latitude`/`longitude` on all surfaces, so a SAB prospect passes; a manually-typed flow still geocodes its address server-side as before. A submission with neither coordinates nor a geocodable location is the only hard rejection, with a clear message.

Centralize the rule in one validator (e.g. `lib/intake/requireLocatable.ts`) so all six endpoints share identical semantics rather than each re-deriving it.

### 2. NAP audit gate — `locationToCitationProfile`

Today `maybeRunNapAudit` gates on `locationToBusinessProfile`, which returns `null` unless name + phone + street + city + region + postcode are all present → SAB audits silently skip.

Add `locationToCitationProfile(businessName, location)` that returns a `CitationBusinessProfile` when **name + city + coordinates** are present; `street_address`/`postcode` default to `''`, `telephone` to `null` when absent. In `maybeRunNapAudit`, the **DFS path** (default provider) gates on this looser builder; the BrightLocal path keeps the strict `locationToBusinessProfile` (its Listings API genuinely needs full NAP).

Result: SAB audits run on name + city + coordinates (the coord-first geo fix already enables this). With a canonical phone, found listings classify `matched`; without, they classify `unverified` (found, NAP not confirmed) — never skipped.

### 3. Per-surface frontend

- **`ClientCreateForm` (agency):** when a GBP pick resolves coordinates but no street number, render a reassuring line — *"Service-area business — scanning from the map pin"* — instead of address-missing friction. In manual mode, add a checkbox *"This business has no public street address (service-area)"* that swaps the required address autocomplete for required **City + Region** (geocoded to centroid via `/api/geocode`) plus the existing manual-coordinate override. Relabel phone *"recommended — sharpens the citation audit."*
- **Public landers (`ScanIntakeForm`, `QuizFlow`, `/yourmap`, onboarding):** already GBP-pick-first. Change is small — stop treating a missing street as an error, show the same SAB affirmation, and ensure the resolved `latitude`/`longitude` are sent (not just the address string).
- **`/api/places/resolve`:** return coordinates + whatever components exist; never 4xx on a missing address.

### 4. Downstream — already handled

The roadmap-summary and coach NAP framing (shipped 2026-06-21) already present "found but NAP unread" correctly, so SAB listings read as *found*, not as false "no phone/address" gaps. No new work; it composes.

## Hardening folded in from the 2026-06-22 code review

These touch the same citation/audit code and are in scope:

- **H1 — `nameMatches` single-token guard (review finding #1).** Filler-stripping can collapse a short brand to one distinctive token (`'On Point'` → `['point']`), matching unrelated listings. SAB matching leans harder on name-only (often no address to corroborate), so this must be fixed here: **do not strip filler when it would leave fewer than 2 distinctive canonical tokens** (fall back to the unstripped token set), preserving both the long-name fix and franchise/short-name protection. Add guard cases: `nameMatches('On Point Plumbing', 'Point Plumbing Supplies')` must be `false`.
- **H2 — `summarizeNapFindingsForPrompt` preserves priority + sibling context (review finding #3).** Keep high/med/low grouping for `missing` and the `occupied_by_sibling` marker, mirroring `renderNapAuditSection`. Import the shared `NapAuditFindings` type instead of re-typing inline (#10).
- **H3 — region map consolidation (review finding #8).** Reuse a single shared subdivision-code→name map (extract one canonical source rather than maintaining `REGION_CODE_TO_NAME` alongside `ABBREV_TO_FULL`). Consider normalizing region at the Places-enrichment write boundary so SABs and all future consumers get spelled-out regions for free — but the read-path expansion stays as defense-in-depth.
- **H4 — provenance note (review finding #9):** acknowledged as a known follow-up — modeling "unverified/unread NAP" structurally (à la `gbpSignalProvenance`) is out of scope for this spec but should not be undone here.

## Testing / guards (`npm run verify`)

- `locationToCitationProfile`: builds a profile from name+city+coords with empty street/postcode; returns `null` when city **or** coordinates are missing.
- `requireLocatable` validator: accepts coords-only; accepts address-only; rejects neither.
- `nameMatches` (extend the existing guard): the single-token false-positive cases above now return `false`; the long-name and franchise cases still pass.

## Edge cases

- **No coordinates from any source** (no pin, city geocode fails, no manual override) → blocked with a clear message; a scan genuinely needs a center point.
- **City geocode failure** → manual-coordinate override fallback.
- **SAB with a phone** → best-quality audit; **without** → audit still runs, listings read `found (unverified)`.

## Out of scope

- Autocomplete disambiguation of same-named businesses across cities (the Wisconsin-vs-Reno collision). Operators add the city to the query; surfaced as a known limitation, not fixed here.
- The regenerate-feature review findings (#2 client alerts, #4 timeout, #5/#6 multi-location) — separate follow-up.
- Structural NAP-provenance modeling (#9, H4).
