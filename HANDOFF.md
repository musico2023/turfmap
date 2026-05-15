# Session Handoff — DFS Citation Checker + VIP Campaign

Last updated: 2026-05-15 ~6pm EDT

## TL;DR

DFS-based NAP audit checker is live in production, replacing the BrightLocal Data API path for all buyer tiers. BL Data API is structurally out of reach for TurfMap (10k req/mo qualification gate, confirmed by Emily Hamblyn / BL Sales on May 14). One-time tier gate (commit `850a51b`) is effectively lifted by the new autoAudit dispatcher — free TurfScans and Visibility Audits now get real NAP findings via DFS at ~$0.09/audit. Sibling-location awareness validated in production on D Spot Brampton Wexford's audit. VIP campaign Stage 1 sends went out; 4 recovery drafts queued for 8:14am May 15 covering prospects who hit the `/freescan` 404 window. Stripe webhook URL fixed (apex→www).

---

## Current state — what's live in production

### NAP audit pipeline (rewritten today)

- **Provider dispatcher** at `lib/brightlocal/autoAudit.ts` chooses `dfs` (default) or `brightlocal` (env-flagged opt-in). Migration `0028_nap_audits_provider.sql` adds `nap_audits.provider` with a CHECK constraint; existing rows backfilled to `brightlocal`.
- **DFS checker** at `lib/citations/` runs Google SERP `site:{domain}` queries for ~9 directories at $0.01/req = ~$0.09 per audit. Synchronous (5-9s elapsed), writes findings + `status='complete'` in one shot. No polling loop needed.
- **Sibling-aware**: listings whose NAP matches another location of the same client get classified as `sibling_match` and added to `missing` with `occupied_by_sibling` populated. Validated live in D Spot Brampton Wexford's AI Coach output ("Nextdoor carries a sibling listing — submit a new separate listing for this location alongside it rather than editing the sibling's record").
- **Tier gate lifted**: free `/freescan` (VIP) + paid `/yourmap` (cold-email) + standalone Audit / Strategy + Pulse / Pulse+ ALL now get NAP audits via DFS. The old `billing_mode='one_time'` short-circuit from commit `850a51b` is removed by the autoAudit refactor (`ce40398`).
- **Directories covered** (home-services profile + country filter): Yelp, Facebook, BBB, Apple Maps, Bing Places, Foursquare, YellowPages US/CA, Nextdoor, Angi (US), HomeAdvisor (US), Thumbtack (US), HomeStars (CAN). Medical profile swaps in Healthgrades, WebMD Care, RateMDs.
- **GBP gap**: Google Business Profile intentionally NOT in the SERP-scrape path — `site:google.com/maps` is invalid Google syntax. Slated for v1.2 via dedicated DFS Business Data API probe (`/v3/business_data/google/my_business_info/live`). Until then, GBP audits are operator's job via BL dashboard.

### VIP Campaign

- 28 of 29 prospects retagged to `cohort='crm_reactivation_q2'`; Justina's 29th prospect (`ay62UUG9SE`) added via one-off Python script.
- Stage 1 hand-sent via Superhuman May 12. 4 recovery drafts queued for **8:14am May 15** (James / Evelyn / Michael / Mike) covering prospects whose page_viewed_at is NULL — they may have clicked during the `/freescan` 404 window (May 13 22:10 EDT → May 14 ~21:00 EDT).
- Stage 2 cron `/api/cron/crmvip-stage2` runs every 15 min. AI Coach nudge cron `/api/cron/ai-coach-nudge` runs every 15 min for prospects who engaged but didn't click Generate.
- First real conversion: Ryan / BVM Contracting (`hVxWpmt1fD`), May 12 17:45 UTC. Engaged in 1s, never clicked Generate, Stage 2 fired at 18:30 UTC, AI Coach nudge fired May 13 00:30 UTC. No upgrade yet.
- Coupon (live mode): 100% off, scan tier only, max 30 redemptions, 60-day expiry.

### Citation Builder (Pulse+)

- Migrated from `/v2/cb/confirm-and-pay` (silently 4xx'd) to `/manage/v1/citation-builder/{id}/confirm` PUT (commit `d1daa97`).
- Country-aware publishers: USA=[dataaxle, neustar, foursquare, gpsnetwork, ypnetwork], CAN=[dataaxle, foursquare, gpsnetwork], AUS=[foursquare, gpsnetwork, locafynetwork], other=[foursquare, gpsnetwork].
- Cost: $0 — BrightLocal Management APIs unlimited.
- Sugar Daddy campaign 965489 still parked in "Saved" state in BL dashboard. Now safe to start since the broader BL Data API budget question is resolved (it's gone, not constrained).

### Marketing landers

- `/fourdots`: two-line H1 ("See exactly where you win — and where you don't." / *"Then go fix it."*) at `text-3xl/4xl/5xl`; body adds "Then you get three specific actions — the ones with the highest impact, in priority order."
- `/yourmap` + `/freescan`: same closing sentence appended to body; personalized H1 ("We already mapped [Business Name]") preserved.
- All hero copy on `feat/marketing-tripwire` branch, merged to main, deployed to www.turfmap.ai.

### Scan UX

- New `components/turfmap/ScanProgress.tsx` overlay with 8 rotating phrases + lime pulse + 1Hz elapsed counter. Modal backdrop blocks panic-refresh double-fires during the 30-90s scan + 5-9s NAP audit + 10-20s AI Coach window.
- Wired into `components/turfmap/ScanButton.tsx`. Will also be drop-in for `/order/success` form submit + AI Coach Generate button in follow-ups.

### Stripe webhook

- URL fixed from `https://turfmap.ai/api/stripe/webhook` (apex, 308-redirected to www) to `https://www.turfmap.ai/api/stripe/webhook`. Failed deliveries from the broken window resent from Stripe Dashboard. No real-customer fulfillment was affected (the `/order/success` page calls `/api/orders/fulfill` directly; the webhook handles downstream events like invoice.paid).

### Production deploy mechanics

- Pushes to `main` do NOT auto-trigger production deploys. Manual `vercel --prod` required.
- Worktree previously had its own `.vercel/project.json` pointing at a throwaway project (`prj_Uo2mT...`, named `kind-albattani-957f10`). Replaced with the real turfmap project (`prj_mvgLx...`) so deploys from the worktree go to www.turfmap.ai. Backup at `.vercel/project.json.worktree-backup`.

---

## What shipped today (May 13-15)

| Commit | What |
|---|---|
| `6c515d5` | feat(engagement): AI Coach nudge cron — 1hr post-engagement, no Generate click |
| `e061319` | feat(landers): hero copy update — two-line H1 on /fourdots + outcome line on all three |
| `d9eabc1` | fix(fourdots): drop H1 size one tier so line 1 fits without secondary wrap |
| `efd1e0e` | fix(emails): force JSX whitespace boundaries with `{' '}` after interps + inline tags |
| `f94113a` | fix(email): sentence-case all sentence starts in AICoachNudge |
| `cdf1375` | feat(citations): DFS-backed NAP audit checker (v1, not yet wired) |
| `9407bea` | fix(citations): tune accuracy — drop GBP, search-URL filter, name containment |
| `7f96e3a` | feat(citations): sibling-location awareness in DFS checker |
| `ce40398` | feat(citations): wire DFS provider into autoAudit, lift one-time tier gate + migration 0028 |
| `3eb0583` | feat(scan-ux): progress overlay + country-filter Nominatim fallback |

---

## BrightLocal — final state

- **Account:** trial API key, 250 Data API requests, hard-stopped.
- **Management API (Citation Builder, LSG):** unlimited on current plan, $0 marginal cost. Stays.
- **Data API (NAP audit):** **NOT AVAILABLE** to TurfMap. Confirmed by Emily Hamblyn (BL Sales) on May 14:
  - Commercial plan starts at 10,000 req/mo at $0.05/req = $500/mo minimum
  - You have to BE USING 10k req/mo to qualify — they don't sell to lower-volume customers
  - At TurfMap's projected ~700-900 req/mo, qualification is ~12+ months away (~1,500 buyers)
  - Path: ping Emily when at-volume; she'll route to API team
- **Synup eval:** also out of range. Account UI shows API access requires Scale tier ($799/mo annual / $999/mo monthly). Per-location Listings Pro add-on at $35/loc/mo makes the structure a poor fit for read-only NAP audits regardless.
- **Outcome:** built the DFS-based replacement instead. Same NapAuditFindings output shape. 30x cheaper. Lower NAP-extraction accuracy than BL Data API but operationally good enough — see today's D Spot Brampton Wexford audit (3 real citations found, 1 NAP inconsistency, 6 actionable missing, sibling detection working).

---

## D Spot data hygiene fix (May 15)

Two `client_locations` rows had bad data:

- **Brampton Wexford**: street_address was correct but city/region/country flipped to "Auckland / Auckland / NZL" during a Nominatim fallback geocode. The autocomplete fallback path (`/api/geocode` → Nominatim) had no country filter, so "1 Wexford Road" resolved to Auckland NZ instead of failing to match.
- **Barrie**: city listed as "Toronto" but actual storefront is in Barrie.

Both corrected via direct SQL. Lat/lng set to approximate values (within ~500m of actual storefronts). Recent audits (one DFS + one older BL) deleted so fresh runs trigger against correct canonical NAP. Root cause patched in `lib/geocoding/nominatim.ts` with `countrycodes=ca,us` filter mirroring AddressAutocomplete's Mapbox default.

---

## Outstanding work

### Pending operator action

1. **Send the 4 recovery drafts** at 8:14am May 15 (already scheduled in Gmail).
2. **Yelp listing for D Spot** at `m.yelp.com/biz/d-spot-dessert-cafe-toronto` shows the wrong address (1060 The Queensway, not the Brampton Wexford address). Claim and redirect, OR investigate whether it's a closed prior D Spot location.
3. **Start Sugar Daddy campaign 965489** in BL dashboard — still parked in "Saved" state. Safe to start now; BL Management API is unlimited and unaffected by Data API decisions.
4. **Vercel auto-deploy from main** — still requires manual `vercel --prod`. The toggle for this lives under Settings → Build and Deployment, not Settings → Git. Find and flip.

### Code backlog

1. **GBP citation probe via DFS Business Data API** (`/v3/business_data/google/my_business_info/live`). v1.2 of the citation checker. Adds structured NAP for the single most important directory.
2. **Re-geocode D Spot Brampton Wexford + Barrie** for precision lat/lng. Approximate values work for scans but tightening to exact storefront coords improves heatmap centering.
3. **GA4 cohort events** — `crm_reactivation_lander_view`, `crm_reactivation_purchase`, `crm_reactivation_audit_upgrade`. P2 deferred. Funnel reporting currently via SQL.
4. **Sample heatmap on cold-email-converted `/yourmap` "already done" state** — works correctly but no end-to-end re-test after the recent score-card casing fix.
5. **Vercel webhook smoke test in CI** — 3-line script that hits each lander + the Stripe webhook after each deploy. Would have caught both the `/freescan` 404 (May 13) and the Stripe redirect issue (May 14) within minutes instead of hours.

---

## Failed experiments / lessons learned (sticky)

- **BL Stoplight docs via WebFetch** — SPA-rendered, doesn't return content. Use Chrome MCP instead.
- **Reading Superhuman shared-conversation links** — deeplink to the Mac app or Chrome extension. Neither readable from MCP. Workaround: Gmail MCP for the same thread.
- **Filling Stripe Checkout via Claude-in-Chrome** — hard-blocked. User types card details (test card `4242 4242 4242 4242` for test mode).
- **Mapbox autofill on Vercel preview URLs** — token has URL restrictions blocking `*.vercel.app`. Type literal address; form accepts it.
- **Push-to-main ≠ production deploy on this Vercel project.** Every push since e061319 only created preview builds. Production stays at the last manual `vercel --prod`. The `/freescan` 404 incident (May 13-14) traced to a stale parent worktree deploy because of this.
- **Worktree `.vercel/project.json` had a different projectId than parent.** First `vercel --prod` from the worktree deployed to a throwaway project at `kind-albattani-957f10.vercel.app`, not turfmap.ai. Replaced the file with parent's contents to deploy correctly. Backup saved.
- **Vercel access logs strip query strings.** Can't identify prospect_ids from 404 logs. Use GA4 or email-tool click data instead.
- **Nominatim fallback had no country filter.** Caused D Spot Brampton Wexford's data to flip to Auckland NZ when the freeform-geocode path ran. Patched in `lib/geocoding/nominatim.ts`.
- **Synup pricing rabbit hole.** Per-location add-on ($35/loc/mo for Listings Pro) makes the cost structure misaligned with TurfMap's read-only NAP check use case — even if the dashboard UI changes its mind about Scale-tier-required, Listings Pro at scale would still be cost-prohibitive.

---

## DFS Citation Checker — operating notes

- **Default provider** for new audits. Env-toggleable via `NAP_AUDIT_PROVIDER=brightlocal` (rare — only when commercial BL access lands).
- **Cost**: ~$0.09 per audit (9 directories × $0.01 DFS Live Advanced).
- **Elapsed**: 5-9s synchronous. Adds to the scan-trigger latency; ScanProgress overlay reassures during the wait.
- **Accuracy edge cases:**
  - Facebook brand pages often return as `unverified` (snippet too sparse to extract phone/address)
  - Apple Maps short snippets also commonly `unverified`
  - Nextdoor + Yelp false positives historically — solved by hard name-gate + search-URL filter
  - GBP entirely skipped — needs v1.2 dedicated probe
- **Sibling logic** only fires when (a) `siblings` array is non-empty AND (b) found listing's NAP fragments include enough address detail to compare. Most siblings only trigger when sibling phone or street number is in the snippet.
- **Refresh window**: 30 days per location. Delete the `nap_audits` row to force a fresh audit on next scan trigger.

---

## Useful one-liners

```sql
-- VIP funnel state
SELECT cohort,
  COUNT(*) AS prospects,
  COUNT(*) FILTER (WHERE converted_at IS NOT NULL) AS converted,
  COUNT(*) FILTER (WHERE scan_engaged_at IS NOT NULL) AS engaged,
  COUNT(*) FILTER (WHERE stage_2_sent_at IS NOT NULL) AS stage_2_sent,
  COUNT(*) FILTER (WHERE ai_coach_nudge_sent_at IS NOT NULL) AS nudge_sent
FROM prospects WHERE cohort = 'crm_reactivation_q2' GROUP BY cohort;

-- All DFS audits run today
SELECT id, provider, status, total_citations, inconsistencies_count,
       missing_high_priority_count, created_at, completed_at
FROM nap_audits
WHERE provider = 'dfs' AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Manually trigger Stage 2 cron
cd ~/Claude/turfmap && \
  export CRON_SECRET=$(grep -E "^CRON_SECRET=" .env.production.local | cut -d= -f2- | tr -d '"') && \
  curl -X POST https://www.turfmap.ai/api/cron/crmvip-stage2 \
    -H "Authorization: Bearer $CRON_SECRET" -i

# Smoke test DFS citation checker against any business
npx tsx scripts/test-dfs-citation-check.ts        # Ryan / BVM Contracting
npx tsx scripts/test-dfs-citation-check-kidcrew.ts  # Kidcrew (sibling-aware)
```

---

## Environment

- Worktree: `~/Claude/turfmap/.claude/worktrees/kind-albattani-957f10/`
  - Branch: `mktg-tripwire-staging` (at current `origin/main` HEAD)
  - `.vercel/project.json` now points at the real turfmap project (was throwaway). Backup at `.vercel/project.json.worktree-backup`.
- Parent worktree: `~/Claude/turfmap/`
  - Branch: `feat/marketing-tripwire` at `c4f038f` — STALE. Don't deploy from here without `git checkout main && git pull` first.
- Push to main: `git push origin HEAD:main` (from worktree)
- Production deploy: `vercel --prod --yes` from this worktree (only place currently safe to deploy from)
- Production: `https://www.turfmap.ai`
- Supabase project: `nwzgbpoaufzznemrqecz` ("TurfMap" org)
- Lead-gen scripts: `~/Claude/Projects/Lead Generation/` (Python; venv at `.venv/`)
- Env files:
  - `.env.local` — populated via `vercel env pull .env.local --environment=production`
  - `BRIGHTLOCAL_API_KEY` shipped in production env; same key handles Management API. **No commercial Data API key.**

---

## Next step

The DFS citation checker is fully wired and validated in production. Nothing critical pending code-side. Operator actions queued: send recovery drafts at 8:14am, claim/fix Yelp listing for D Spot, start Sugar Daddy 965489 in BL dashboard.

**If next session picks up:**
1. Monitor first 24h of organic DFS audits — accuracy vs operator expectations
2. v1.2 GBP probe via DFS Business Data API (single new probe path; ~1-2h work)
3. Wire ScanProgress overlay into `/order/success` form submit + AI Coach Generate button
4. Find + flip the Vercel "auto-deploy from main" toggle so push-to-main stops being a footgun
