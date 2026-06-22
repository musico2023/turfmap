# Service-Area Business Intake Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a service-area business (no public street address) be onboarded and audited from every intake surface, using map-pin coordinates instead of a street address.

**Architecture:** One principle — coordinates are the requirement, street address optional. A shared `requireLocatable` validator replaces per-endpoint "address required"; a new `locationToCitationProfile` lets the DFS NAP audit run on name+city+coords instead of skipping; frontends show a "scanning from the map pin" affirmation and send resolved coordinates. Three review-finding hardenings (nameMatches single-token guard, NAP-summary priority/sibling preservation, region-map consolidation) are folded in because they live in the same code.

**Tech Stack:** Next.js 15 (App Router) + TypeScript, Zod validation, Supabase, DataForSEO citation probes. Tests are `tsx` guard scripts wired into `npm run verify` (the repo's convention — there is no jest/vitest).

**Build gate:** `npm run build` runs `verify && lint && next build`. After each task: `npx tsc --noEmit`, `npx eslint <files>`, and `npm run verify`.

---

### Task 1: Harden `nameMatches` against single-token collapse (review finding #1)

Filler-stripping can reduce a short brand to one distinctive token (`'On Point'` → `['point']`), matching unrelated listings. Fix: never strip filler when it would leave fewer than 2 distinctive tokens.

**Files:**
- Modify: `lib/citations/napCompare.ts:85-110` (`nameMatches`)
- Test: `scripts/verify-citation-name-match.ts`

- [ ] **Step 1: Add failing guard cases** — append before the final `if (failures > 0)` block in `scripts/verify-citation-name-match.ts`:

```ts
// Short-brand guard: a load-bearing stopword must not collapse the name to
// one token and match an unrelated business (review finding #1).
check(
  'rejects unrelated "Point" business for canonical "On Point Plumbing"',
  nameMatches('On Point Plumbing', 'Point Plumbing Supplies Inc'),
  false
);
check(
  'rejects "Inn at the Lake" for canonical "The Inn"',
  nameMatches('The Inn', 'Inn at the Lake'),
  false
);
check(
  'still matches long franchise name after the guard',
  nameMatches(CANON, 'CertaPro Painters of Calgary & Central Alberta | Calgary AB'),
  true
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-citation-name-match.ts`
Expected: FAIL — the two `false` cases currently return `true`.

- [ ] **Step 3: Implement the guard** — replace the token-build in `nameMatches`:

```ts
export function nameMatches(
  canonical: string | null | undefined,
  found: string | null | undefined
): boolean {
  const rawA = normalizeName(canonical).split(/\s+/).filter(Boolean);
  const rawB = normalizeName(found).split(/\s+/).filter(Boolean);
  // Strip generic connectors so a long legal name still matches a short
  // directory title — UNLESS stripping collapses the canonical below 2
  // distinctive tokens (a load-bearing stopword like "On Point" → "point"
  // would otherwise match any "...point..." listing). In that case keep
  // the unstripped tokens so the bar stays meaningful.
  const strippedA = rawA.filter((t) => !NAME_FILLER.has(t));
  const a = strippedA.length >= 2 ? strippedA : rawA;
  const b = new Set(
    (a === strippedA ? rawB.filter((t) => !NAME_FILLER.has(t)) : rawB)
  );
  if (a.length === 0 || b.size === 0) return false;
  const matched = a.filter((t) => b.has(t)).length;
  return matched / a.length >= 0.75;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/verify-citation-name-match.ts`
Expected: PASS (all cases, including the original long-name + franchise rails).

- [ ] **Step 5: Commit**

```bash
git add lib/citations/napCompare.ts scripts/verify-citation-name-match.ts
git commit -m "fix(citations): nameMatches must not collapse short brands to one token"
```

---

### Task 2: `locationToCitationProfile` — let the DFS audit run for SABs

**Files:**
- Modify: `lib/brightlocal/autoAudit.ts` (add builder; branch the gate in `maybeRunNapAudit`)
- Test: Create `scripts/verify-citation-profile.ts`; add to `package.json` `verify`

- [ ] **Step 1: Write the failing guard** — create `scripts/verify-citation-profile.ts`:

```ts
/** Guard: locationToCitationProfile runs the DFS audit for a SAB (name +
 *  city + coords) and only bails when the true minimum is missing. */
import { locationToCitationProfile } from '../lib/brightlocal/autoAudit';

let failures = 0;
const check = (label: string, cond: boolean) => {
  if (!cond) { failures++; console.error(`✗ ${label}`); } else console.log(`✓ ${label}`);
};

const sab = locationToCitationProfile('Anew Bathtub Repair', {
  phone: null, street_address: null, city: 'Reno', region: 'NV',
  postcode: null, country_code: 'USA', latitude: 39.52, longitude: -119.81,
});
check('SAB profile builds from name+city+coords', sab !== null);
check('SAB street_address defaults to empty', sab?.street_address === '');
check('SAB telephone null tolerated', sab?.telephone == null);

const noCity = locationToCitationProfile('X', {
  phone: null, street_address: null, city: null, region: 'NV',
  postcode: null, country_code: 'USA', latitude: 39.5, longitude: -119.8,
});
check('returns null without a city', noCity === null);

const noCoords = locationToCitationProfile('X', {
  phone: '7755551212', street_address: '1 A St', city: 'Reno', region: 'NV',
  postcode: '89501', country_code: 'USA', latitude: null, longitude: null,
});
check('returns null without coordinates', noCoords === null);

if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nverify-citation-profile: all checks passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-citation-profile.ts`
Expected: FAIL — `locationToCitationProfile` is not exported.

- [ ] **Step 3: Implement the builder** — add to `lib/brightlocal/autoAudit.ts` near `locationToBusinessProfile`:

```ts
/** SAB-tolerant profile for the DFS citation audit. Unlike
 *  locationToBusinessProfile (which requires the full structured NAP for
 *  BrightLocal's Listings API), the DFS probes match on name + city +
 *  coordinates, so a service-area business with no street address still
 *  gets a real audit. street_address/postcode default to '' and phone to
 *  null when absent — classifyCitation already treats those as
 *  "found, unverified" rather than a mismatch. Returns null only when the
 *  true minimum (name + city + coordinates) is missing. */
export function locationToCitationProfile(
  businessName: string,
  location: Pick<
    ClientLocationRow,
    'phone' | 'street_address' | 'city' | 'region' | 'postcode'
    | 'country_code' | 'latitude' | 'longitude'
  >
): CitationBusinessProfile | null {
  if (
    !businessName ||
    !location.city ||
    location.latitude == null ||
    location.longitude == null
  ) {
    return null;
  }
  return {
    name: businessName,
    street_address: location.street_address ?? '',
    city: location.city,
    region: location.region ?? '',
    postcode: location.postcode ?? '',
    country: location.country_code ?? 'USA',
    telephone: location.phone ?? null,
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
  };
}
```

Add the import at the top of `autoAudit.ts` if not present:
```ts
import type { CitationBusinessProfile } from '@/lib/citations/dfsChecker';
```

- [ ] **Step 4: Branch the audit gate** — in `maybeRunNapAudit`, replace the single gate (around line 210-217) so the DFS path uses the looser builder while BrightLocal keeps the strict one:

```ts
  // 4. Profile gate. DFS matches on name+city+coords (service-area
  //    businesses have no street address), so it uses the looser
  //    locationToCitationProfile. BrightLocal's Listings API needs the
  //    full NAP, so it keeps locationToBusinessProfile.
  const provider = pickProvider();
  const dfsProfile = locationToCitationProfile(client.business_name, location);
  const blProfile = locationToBusinessProfile(client.business_name, location);
  const business = provider === 'dfs' ? blProfile ?? dfsProfileAsBusiness(dfsProfile) : blProfile;
  if (provider === 'dfs' ? !dfsProfile : !business) {
    return {
      ran: false,
      reason:
        provider === 'dfs'
          ? 'location missing name/city/coordinates'
          : 'location missing structured NAP fields',
    };
  }
```

NOTE: `runDfsAudit` currently takes a `BusinessProfile` and rebuilds a `CitationBusinessProfile` from it. Simplify by having the DFS path pass the `CitationBusinessProfile` directly. Change `runDfsAudit`'s signature to accept `CitationBusinessProfile` (it already constructs one internally at lines 335-345 — delete that reconstruction and use the passed profile), and pass `dfsProfile` to it. Remove the `dfsProfileAsBusiness` shim — instead call `runDfsAudit(supabase, clientId, location.id, triggeredBy, dfsProfile, effectiveIndustry, location.latitude, location.longitude, triggerSource)` and have `runDfsAudit` use the profile as `canonical` directly. Keep `runBrightlocalAudit` on `blProfile` (guarded by `if (!blProfile) return skip` inside the BL branch).

- [ ] **Step 5: Run typecheck + guard**

Run: `npx tsc --noEmit && npx tsx scripts/verify-citation-profile.ts`
Expected: PASS.

- [ ] **Step 6: Wire guard into verify + commit**

In `package.json`, append to `verify`: ` && tsx scripts/verify-citation-profile.ts`.

```bash
git add lib/brightlocal/autoAudit.ts scripts/verify-citation-profile.ts package.json
git commit -m "feat(citations): DFS NAP audit runs for service-area businesses (name+city+coords)"
```

---

### Task 3: Shared `requireLocatable` validator + apply to intake endpoints

**Files:**
- Create: `lib/intake/requireLocatable.ts`
- Test: Create `scripts/verify-require-locatable.ts`; add to `verify`
- Modify: `app/api/clients/route.ts`, `app/api/score/preview-init/route.ts`, `app/api/score/unlock-init/route.ts`, `app/api/scan/checkout/init/route.ts`, `app/api/yourmap/coldscan-fulfill/route.ts`, `app/api/onboarding/[publicId]/route.ts`

- [ ] **Step 1: Write the failing guard** — create `scripts/verify-require-locatable.ts`:

```ts
import { hasLocatableCenter } from '../lib/intake/requireLocatable';

let failures = 0;
const check = (l: string, c: boolean) => { if (!c) { failures++; console.error(`✗ ${l}`); } else console.log(`✓ ${l}`); };

check('coords-only is locatable', hasLocatableCenter({ latitude: 39.5, longitude: -119.8, address: null }));
check('address-only is locatable', hasLocatableCenter({ latitude: null, longitude: null, address: '100 Queen St W, Toronto' }));
check('neither is rejected', !hasLocatableCenter({ latitude: null, longitude: null, address: null }));
check('blank address + no coords rejected', !hasLocatableCenter({ latitude: null, longitude: null, address: '   ' }));

if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nverify-require-locatable: all checks passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-require-locatable.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `lib/intake/requireLocatable.ts`:

```ts
/** A scan needs a center point. It can come from map-pin coordinates (the
 *  GBP pick supplies these even for a service-area business with no street
 *  address) OR a geocodable address string. This is the single rule every
 *  intake endpoint shares — never "street address required". */
export function hasLocatableCenter(input: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  address: string | null | undefined;
}): boolean {
  const hasCoords =
    typeof input.latitude === 'number' && typeof input.longitude === 'number';
  const hasAddress = Boolean(input.address && input.address.trim().length >= 4);
  return hasCoords || hasAddress;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/verify-require-locatable.ts`
Expected: PASS.

- [ ] **Step 5: Apply to each endpoint.** For EACH of the six routes: (a) in the Zod body, change `address: z.string().min(4).max(400)` → `address: z.string().max(400).optional().nullable()`; (b) after parsing, add the guard:

```ts
import { hasLocatableCenter } from '@/lib/intake/requireLocatable';
// ...after the parsed body is available:
if (!hasLocatableCenter({ latitude: parsed.latitude, longitude: parsed.longitude, address: parsed.address })) {
  return NextResponse.json(
    { error: 'Pick the business on Google or enter a city/address — we need a location to center the scan.' },
    { status: 400 }
  );
}
```

(c) Wherever the route uses `parsed.address` to geocode, guard it: only geocode when `parsed.address` is present AND coords are absent; when coords are present, use them directly. For `app/api/clients/route.ts`, `latitude`/`longitude` are already required — only the `address` relaxation + guard apply there.

Verify each route still compiles: `npx tsc --noEmit`.

- [ ] **Step 6: Wire guard into verify + commit**

`package.json` `verify`: append ` && tsx scripts/verify-require-locatable.ts`.

```bash
git add lib/intake/requireLocatable.ts scripts/verify-require-locatable.ts package.json app/api/clients/route.ts app/api/score/preview-init/route.ts app/api/score/unlock-init/route.ts app/api/scan/checkout/init/route.ts app/api/yourmap/coldscan-fulfill/route.ts app/api/onboarding/[publicId]/route.ts
git commit -m "feat(intake): accept coordinates-or-address across all intake endpoints (SAB support)"
```

---

### Task 4: `ClientCreateForm` — SAB affirmation + manual no-address mode

**Files:**
- Modify: `components/turfmap/ClientCreateForm.tsx`

- [ ] **Step 1: GBP affirmation.** In `GbpMatchedCard`, when `place.formattedAddress` has no digit (no street number) but coords exist, render a lime note: `Service-area business — we'll scan from the map pin.` Detection: `const isServiceArea = !/\d/.test(place.formattedAddress) && place.latitude != null;`

- [ ] **Step 2: Manual no-address mode.** Add form state `noStreetAddress: boolean`. In `gbpMode === 'manual'`, render a checkbox *"This business has no public street address (service-area)."* When checked: hide the required `AddressAutocomplete`; render required **City** + **Region** inputs (already in `form`) and keep the "override coordinates manually" toggle visible. On City/Region change (debounced), call `/api/geocode` with `\`${form.city}, ${form.region}\`` to populate `latitude`/`longitude` (city centroid). Make the `AddressAutocomplete` `required` prop conditional: `required={!form.noStreetAddress}`.

- [ ] **Step 3: Submit.** In `onSubmit`, when `noStreetAddress`, send `street_address: null` and `address: form.city.trim() || null`; keep the lat/lng requirement (now satisfied by the centroid geocode or manual override). Relabel the phone field help to `recommended — sharpens the citation audit`.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npx eslint components/turfmap/ClientCreateForm.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/turfmap/ClientCreateForm.tsx
git commit -m "feat(intake): ClientCreateForm supports service-area businesses (no address)"
```

---

### Task 5: Public landers — SAB affirmation + send resolved coordinates

**Files:**
- Modify: `components/marketing/scan/ScanIntakeForm.tsx`, `components/free-score-now/QuizFlow.tsx`, and the `/yourmap` + onboarding intake components

- [ ] **Step 1:** In each lander's GBP-pick handler, confirm the resolved `latitude`/`longitude` are forwarded in the POST body to the scan endpoint (Task 3 now requires coords-or-address; these landers must send coords). Where a lander only sent `address`, add `latitude`/`longitude` from the resolved place.

- [ ] **Step 2:** When the resolved place has no street number but has coords, show the same one-line affirmation ("Service-area business — scanning from the map pin") instead of any address-required error.

- [ ] **Step 3:** `app/api/places/resolve/route.ts` — confirm it returns coords + components and never 4xx when Google omits the address (it already returns whatever `details` holds; add a regression note only).

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npx eslint components/marketing/scan/ScanIntakeForm.tsx components/free-score-now/QuizFlow.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/marketing/scan/ScanIntakeForm.tsx components/free-score-now/QuizFlow.tsx
git commit -m "feat(intake): public scan landers support service-area businesses"
```

---

### Task 6: Harden `summarizeNapFindingsForPrompt` — preserve priority + sibling (review finding #3, #10)

**Files:**
- Modify: `lib/audit/auditDataLoaders.ts`
- Test: Create `scripts/verify-nap-summary-framing.ts` additions (extend existing)

- [ ] **Step 1: Add failing cases** to `scripts/verify-nap-summary-framing.ts` using a findings object with a high-priority missing dir, a low-priority one, and a `missing` entry carrying `occupied_by_sibling`:

```ts
const f2 = {
  citations: [{ directory: 'google_business', status: 'matched' }],
  missing: [
    { directory: 'yelp', priority: 'high' },
    { directory: 'nextdoor', priority: 'low', occupied_by_sibling: { sibling_label: 'Downtown', sibling_address: '1 A St' } },
  ],
  inconsistencies: [],
};
const out2 = summarizeNapFindingsForPrompt(f2);
check('keeps high-priority grouping', /high-priority[^\n]*yelp/i.test(out2));
check('flags sibling-occupied directory', /nextdoor[^\n]*sibling/i.test(out2));
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/verify-nap-summary-framing.ts`
Expected: FAIL — current output is a flat comma list with no priority/sibling.

- [ ] **Step 3: Implement.** Import the shared type (`import type { NapAuditFindings } from '@/lib/supabase/types';`) and replace the flat `notFound` join with priority grouping + sibling markers, mirroring `renderNapAuditSection` (turfCoach.ts:516-545): group `missing` by `priority`, and for each entry with `occupied_by_sibling`, append `(sibling "<label>" already listed at <address>)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/verify-nap-summary-framing.ts`
Expected: PASS (including the existing null-leak cases).

- [ ] **Step 5: Commit**

```bash
git add lib/audit/auditDataLoaders.ts scripts/verify-nap-summary-framing.ts
git commit -m "fix(audit): NAP summary keeps missing-priority + sibling-occupancy for the roadmap AI"
```

---

### Task 7: Consolidate the region-code map (review finding #8)

**Files:**
- Create: `lib/geo/regionNames.ts` (single canonical alpha-2 → full subdivision map)
- Modify: `lib/citations/dfsChecker.ts` (import instead of local `REGION_CODE_TO_NAME`)

- [ ] **Step 1:** Move the `REGION_CODE_TO_NAME` table from `dfsChecker.ts` into `lib/geo/regionNames.ts` as `export const REGION_CODE_TO_NAME` (title-cased values — the DFS `location_name` form). Export a helper `expandRegion(code: string): string` returning the full name or the input unchanged.

- [ ] **Step 2:** In `dfsChecker.ts`, delete the local map and `import { expandRegion } from '@/lib/geo/regionNames';`; use `expandRegion(rawRegion)` in `dfsLocationFromBusiness`.

- [ ] **Step 3: Run guards**

Run: `npx tsc --noEmit && npx tsx scripts/verify-dfs-citation-geo.ts`
Expected: PASS (AB→Alberta etc. unchanged).

- [ ] **Step 4: Commit**

```bash
git add lib/geo/regionNames.ts lib/citations/dfsChecker.ts
git commit -m "refactor(geo): single canonical region-code map shared across consumers"
```

---

### Final: full build gate

- [ ] Run `npm run build` (verify + lint + next build). Expected: clean.
- [ ] Manually exercise: add Anew Bathtub Repair via the agency form with no street address (city Reno + map pin) → scan runs → NAP audit runs (not skipped) → Yelp/Angi/BBB found.

## Self-review notes
- **Spec coverage:** §1 backend rule → Task 3; §2 audit gate → Task 2; §3 frontends → Tasks 4-5; H1 → Task 1; H2 → Task 6; H3 → Task 7; H4 (provenance) explicitly out of scope. All covered.
- **Type consistency:** `locationToCitationProfile` returns `CitationBusinessProfile | null`; `runDfsAudit` is updated to accept that type directly (Task 2 Step 4). `hasLocatableCenter` signature is stable across Task 3 and the endpoints.
- **Out of scope (separate follow-up):** regenerate review findings #2 (client alerts), #4 (timeout), #5/#6 (multi-location); autocomplete disambiguation.
