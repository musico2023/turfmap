# LLM Funnel Tracker — Handoff & Scope Doc

**Audience:** the agent / contributor responsible for funnel analytics, conversion attribution, and reporting on TurfMap lander performance.

**Purpose:** Lock down the boundary between the funnel-tracker domain and the lander/checkout domain so the two stop colliding. This doc is the source of truth for what the tracker may and may not modify.

---

## Why this exists

The lander stack (`/scan`, `/scan/intake`, `/fourdots`, `/yourmap`, `/freescan`) ships against a tight conversion brief. Recent incidents:

1. **2026-05-22** — The tracker rewrote `app/scan/page.tsx` as a Stripe-first redirect, replacing the intake-first paid-Meta lander with a clone of `/fourdots`. Production deploy fired before the conflict surfaced at GitHub. Recovery: cherry-pick the tracker's analytics commits + reset the parent worktree, redeploy from `kind-albattani-957f10`.
2. **2026-05-21** — Stale parent-worktree `next.config.ts` reintroduced a legacy 308 redirect on `/scan`, breaking the lander after a routine deploy.

These cost real revenue (Meta paid traffic was already running). The boundary below is non-negotiable.

---

## File ownership

### 🚫 OUT OF SCOPE — do not modify

The tracker MUST NOT touch any of the following files without explicit authorization from Anthony:

#### Lander pages (paid + organic + cold-email)
- `app/scan/page.tsx` — paid-Meta cold lander (`MAPCHECK50`)
- `app/scan/intake/page.tsx` — intake form (sits between every lander and Stripe)
- `app/fourdots/page.tsx` — Fourdots homepage lander
- `app/yourmap/page.tsx` — cold-email lander (`COLDSCAN` free)
- `app/freescan/page.tsx` — warm-cohort VIP lander (`VIP` free)
- `app/share/[id]/page.tsx` — buyer-facing scan share page
- `app/order/success/page.tsx` + `app/order/success/OrderSuccessForm.tsx` — post-checkout success state

#### Marketing components
- `components/marketing/scan/*` — every file in this directory
- `components/marketing/AuditUpgradePanel.tsx` — $197 upgrade UI
- `components/marketing/ScanCheckoutButton.tsx` — legacy Stripe-first button (kept for revert path)
- `components/marketing/ScanIntakeLinkButton.tsx` — the intake-first replacement

#### Checkout + fulfillment routes
- `app/api/checkout/[tier]/route.ts` — legacy Stripe-first init
- `app/api/scan/checkout/init/route.ts` — intake-first init
- `app/api/orders/fulfill/route.ts` — post-payment fulfillment
- `app/api/upgrade/audit/confirm/route.ts` — $197 1-click upgrade
- `app/api/upgrade/audit/create-session/route.ts` — fallback Checkout for 3DS / no-saved-card
- `app/api/yourmap/coldscan-fulfill/route.ts` — COLDSCAN free bypass

#### Stripe / session / coupon plumbing
- `lib/stripe/*` — session loader, lead-orders helpers, client
- `lib/coupons/*` — coupon registry
- `lib/audit/operatorSlack.ts` — operator notification templates (you ADD analytics; do not edit existing templates)

### ✅ IN SCOPE — tracker owns these

- `lib/analytics/*` — every existing + new file in this directory belongs to the tracker
- `app/api/analytics/*` — analytics ingestion / query endpoints
- `app/api/admin/funnel/*` — operator dashboard data routes
- `app/admin/funnel/*` — operator dashboard pages
- `supabase/migrations/*_funnel_*.sql` — analytics-specific tables (use the `_funnel_` infix in filenames so ownership is greppable)
- Scanner UA filter / bot-traffic exclusion in `lib/analytics/landerVisits.ts`
- Conversion attribution joins between `ops_lander_visits`, `lead_orders`, `prospects`, and `visibility_audits`
- Any reporting query layer that READS from the schema but does not modify lander or checkout behavior

### 🤝 SHARED — propose changes via PR, do not modify directly

These need both-sides review:

- `vercel.json` (cron definitions touch the funnel)
- `next.config.ts` (rewrites / redirects ripple into the lander URLs)
- `lib/email/resend.ts` (transactional email senders share infra)
- Schema tables: `lead_orders`, `prospects`, `clients`, `scan_share_links`, `visibility_audits`

---

## Canonical funnel architecture (as of 2026-05-27)

```
  [Meta ad / cold email / direct link]
              │
              ▼
   ┌─────────────────────────┐
   │  Lander page            │  /scan · /fourdots · /yourmap · /freescan
   │  - Hero + CTA           │
   │  - Pixel: PageView      │
   │                         │
   │  CTA: ScanIntakeLinkButton
   │  - Fires Meta ScanCtaClick
   └────────────┬────────────┘
                │ Link navigation (preserves ALL utm_* + gclid + fbclid + coupon + prospect_id)
                ▼
   ┌─────────────────────────┐
   │  /scan/intake           │  Form page (5 fields)
   │  - Mapbox autocomplete  │    business name / address / keyword / email / business phone
   │  - Pixel: InitiateCheckout on submit
   └────────────┬────────────┘
                │ POST /api/scan/checkout/init
                ▼
   ┌─────────────────────────┐
   │  Stripe Checkout         │  Session.metadata includes:
   │                         │    tier, source='scan_intake', business_name, address,
   │                         │    keyword, intake_email, phone, coupon, utm_*, gclid,
   │                         │    fbclid, prospect_id, cohort, latitude, longitude,
   │                         │    street_address, city, region, postcode, country_code
   └────────────┬────────────┘
                │ Stripe success_url → /order/success?session_id=...
                ▼
   ┌─────────────────────────┐
   │  /order/success         │  Auto-fulfills via POST /api/orders/fulfill
   │  - Detects metadata.source='scan_intake'
   │  - Shows <ScanProgress> overlay
   │  - Pixel: Purchase
   └────────────┬────────────┘
                │
                ▼
       Scan running → dashboard / share page
```

### Special path: COLDSCAN (cold-email free)

`/yourmap` cohort with `COLDSCAN` coupon bypasses Stripe entirely:

```
  /yourmap (prospect_id present, coupon=COLDSCAN)
       │
       │ ScanIntakeLinkButton → /scan/intake?coupon=COLDSCAN&prospect_id=...
       │
       │ Form submit → /api/yourmap/coldscan-fulfill (no Stripe call)
       │
       ▼
  Share link created → /share/<id>
       │
       │ scan_engaged_at stamps via engaged route
       ▼
  cold-stage3 follow-up email pitches discounted audit
```

The COLDSCAN path is **not** routed through `/api/orders/fulfill` or `/order/success`. It has its own UNIQUE partial index (`lead_orders_coldscan_prospect_uidx`) preventing duplicate scans per prospect.

---

## Pixel events — wired and where

Reference for analytics integrations — do not re-fire these; hook reporting onto them.

| Event | Type | Fires from | Notes |
|---|---|---|---|
| `PageView` | Meta + GA4 | All landers (mount) | `MetaPixel` component |
| `ViewContent` | Meta | `/scan` hero in-view | TurfScan content_name |
| `ScanCtaClick` | Meta (custom) | `ScanIntakeLinkButton` onClick | Mid-funnel intent signal |
| `InitiateCheckout` | Meta + GA4 `begin_checkout` | `ScanIntakeForm` submit | Replaces former Stripe-CTA-click firing |
| `AddToCart` | Meta | `/scan` audit-upgrade panel view | Upgrade interest |
| `Purchase` | Meta + GA4 | `/order/success` post-fulfill | Includes amount_total + currency |
| `WatchVideo` | Meta (custom) | `LoomWalkthrough` play | Engagement signal |

All pixel calls funnel through `components/marketing/scan/MetaPixel.tsx`'s `trackMetaEvent()` helper. If you need to add a NEW event, extend this helper rather than firing `fbq()` inline.

---

## Coupon registry — additive only

Current coupons:

| Code | Price | Cohort | Lander |
|---|---|---|---|
| `MAPCHECK50` | $49 | paid-Meta cold | `/scan` |
| `FOURDOTS50` | $49 | warm referral | `/fourdots` |
| `VIP` | $0 | warm reactivation | `/freescan` |
| `COLDSCAN` | $0 | cold-email | `/yourmap` |

Rule: **only ADD coupons; never remove existing ones.** Removing a coupon kills any live ad referencing it. If a coupon is deprecated, leave the registry entry in place but stop linking from the lander.

The 100%-off list (`VIP`, `COLDSCAN`) is hardcoded in two places — both must stay in sync:

- `app/api/checkout/[tier]/route.ts` (`isHundredPercentOffCoupon`)
- `app/api/scan/checkout/init/route.ts` (`isHundredPercentOffCoupon`)

Stripe rejects `setup_future_usage='off_session'` on $0 PaymentIntents, so the off-session card save is skipped for these codes. The audit-upgrade $302 credit is also gated on `amountTotal > 0`, so free buyers never see the upgrade panel.

---

## Slack notifications — operator feed in `#llm-leads`

Wired via `lib/audit/operatorSlack.ts`. All notifications fail-soft. Webhook URL lives in `OPERATOR_SLACK_WEBHOOK_URL` env var (Production only).

| Notification | Fires from | Trigger |
|---|---|---|
| `notifyTurfScanPurchase` | `/api/orders/fulfill` | Any paid lander tier (scan / audit / strategy / pulse / pulse_plus) successfully fulfilled |
| `notifyAuditUpgradePurchase` | `/api/upgrade/audit/confirm` | $197 1-click upgrade PaymentIntent succeeded |
| `notifyColdscanCompleted` | `/api/yourmap/coldscan-fulfill` | COLDSCAN free buyer share link created |
| `notifyLlmFitAudit` | `/api/orders/fulfill` (audit tier) | Audit purchase with LLM fit score ≥ 4 |
| `notifyAuditUnscheduled` | `/api/cron/audit-7day-unscheduled` | Audit buyer hit day 7 without Cal.com booking |
| `notifySixtyDayUnresponsive` | `/api/cron/audit-60day-checkin` | Audit buyer at day 67 with no response |

If the tracker needs a new operator notification, extend `operatorSlack.ts` with a new `notifyXxx()` function following the existing `text + blocks` pattern. Do not edit existing templates' shapes — downstream dashboards parse the text format.

---

## Deploy workflow — non-negotiable

1. **PUSH to `origin/main` BEFORE running `vercel --prod`.** Forces fast-forward check at GitHub. Conflicts surface in `git push` rather than at Vercel build time.
2. **Never deploy from a worktree that has uncommitted changes to lander files.** If you've been editing analytics and a `git status` shows changes in `app/scan/` or `components/marketing/scan/`, stop — those changes weren't yours.
3. **Worktree hygiene.** This repo has multiple worktrees under `~/Claude/turfmap/.claude/worktrees/`. Always confirm which worktree you're operating in via `git worktree list`. The lander/checkout work happens primarily on `kind-albattani-957f10`. If you're working in the parent worktree (`~/Claude/turfmap`), pull from `origin/main` BEFORE editing.
4. **Conflicts on shared schema migrations** — coordinate over Slack DM with Anthony before applying a `supabase migration up`. Production schema changes that affect `lead_orders`, `prospects`, `clients`, `visibility_audits` are blocking concerns.

---

## When in doubt

If you're about to modify a file in the OUT-OF-SCOPE list above and you believe it's the right call, **stop and ask Anthony in `#llm-leads`** with:

- The file path
- The specific lines you'd change
- The analytics/tracking goal that requires the change
- An alternative path you considered that stays in IN-SCOPE territory

Almost every funnel-tracker need can be served by adding rows to `ops_lander_visits` or extending the analytics query layer — modifications to the lander pages themselves are very rarely the right answer.

---

**Last updated:** 2026-05-27
**Maintained by:** Anthony (Fourdots) + the lander team
**Tracker scope owner:** TBD — assign before next deploy
