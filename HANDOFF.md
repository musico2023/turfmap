# Session Handoff — VIP Campaign + Citation Builder (Pulse+)

Last updated: 2026-05-12 ~1:30am EDT

## Goal

Two parallel workstreams:

1. **VIP Campaign (Q2 CRM warm reactivation)** — hand-send Stage 1 free-TurfScan
   emails to 29 prior Fourdots booking-form leads. Auto-fire Stage 2 audit-upgrade
   email 30 min – 24 hr after they engage with their scan dashboard. Goal: convert
   warm cohort into $197 Visibility Audit upgrades.

2. **Citation Builder on Pulse+** — bundle BrightLocal Citation Builder into the
   Pulse+ subscription so Pulse+ buyers can fire a one-click citation-submission
   campaign for their NAP.

## Current state — what's live in production

### VIP Campaign — fully wired end-to-end, validated via smoke test

- `/freescan` lander (warm-cohort copy, $0 Stripe Checkout w/ VIP coupon, no card form)
- $0 Stripe Checkout edge handled (`setup_future_usage` skipped for 100%-off coupons)
- `/order/success` and `/portal/[slug]` dashboard suppress AuditUpgradePanel + PulseAttachPanel for `cohort='crm_reactivation_q2'`
- VIP-specific copy on `/order/success`: "Your free TurfScan order is confirmed" + Anthony followup line
- "Baseline scan complete" banner hidden for one-time buyers (only renders for Pulse subs)
- Engagement endpoint `POST /api/prospect/[id]/engaged` fires on dashboard load, stamps `scan_engaged_at`
- Stage 2 cron `/api/cron/crmvip-stage2` runs every 15 min, sends audit-upgrade email
- `/audit-upgrade` page handles Stage 2 click → redirects to `/api/upgrade/audit/create-session?source=stage_2_email` → Stripe upgrade Checkout (`$197` via UPGRADE_302_CREDIT)
- Intake form keyword pre-fill from `prospects.trade`
- FAQ rewrites for both `/yourmap` and `/freescan` (geo-grid mechanic clarification)
- Score-readout labels render PascalCase (TurfReach not TURFREACH)
- 28 prospects retagged to `cohort='crm_reactivation_q2'` via SQL
- 29th prospect (Justina W / Signature Landscape Construction / `ay62UUG9SE`) added via one-off Python script
- VIP Stripe coupon created in live mode (100% off, scan tier only, max 30 redemptions, 60-day expiry)
- Migration 0026_prospects_cohort.sql applied to production Supabase
- Migration 0025_prospects_business_name_check.sql applied (SMOKE TEST prefix CHECK constraint)

### Citation Builder on Pulse+ — code ready, $0 cost

- Code path migrated to BL Management APIs (`/manage/v1/citation-builder`)
- Confirm-and-pay migrated from deprecated `/v2/cb/confirm-and-pay` POST to **`/manage/v1/citation-builder/{id}/confirm` PUT** (commit `d1daa97`)
- New `confirmCampaignManageV1()` helper with `publishersForCountry()` (USA: 5 publishers, Canada: 3, Australia: 3, other: 2)
- Tier-gated to `pulse_plus` via `canAccessCitations()`
- Env vars set on production Vercel (`BRIGHTLOCAL_API_KEY`, `CITATION_BUILDER_ENABLED=true`)
- Cost: $0 — BrightLocal Management APIs unlimited per Rhea's May 11 reply

### NAP audit — gated to recurring tiers to preserve BL Data API trial

- `maybeRunNapAudit()` at `lib/brightlocal/autoAudit.ts` now bails early when `client.billing_mode === 'one_time'`
- Effect: free `/freescan` (VIP) + paid `/yourmap` (cold-email) + standalone Audit / Strategy purchases NO LONGER fire NAP audits
- Pulse / Pulse+ / agency-managed clients still get full NAP-driven AI Coach output
- Rationale: Rhea (BL Support) confirmed May 12 that the 250-request trial cap is a HARD STOP, not an auto-billed threshold. Per-request commercial pricing requires a new commercial-key arrangement (Sales conversation in flight). One NAP audit ≈ 3-10 BL Data API requests; trial buys us ~25-80 audits total. Without this gate, the VIP campaign alone could exhaust the trial mid-launch.
- Revert path: once commercial Data API key is in place, revert commit `850a51b` to re-enable for one-time tiers.

### Commits shipped to main today (in order)

| Hash | What |
|---|---|
| `9341f0f` | Cowork patch + engagement hook + stage_2_email upgrade source + /audit-upgrade page + migration 0026 |
| `317e318` | $0 Stripe gate (skip `setup_future_usage` for 100%-off coupons) |
| `050eb41` | /freescan closing CTA copy unified with /yourmap |
| `ee88695` | Warm-cohort suppression on /order/success + dashboard + FAQ swap |
| `b0086cf` | Persist cohort + prospect_id into `lead_orders.stripe_metadata` |
| `4edd0fc` | Hide one-time-buyer baseline banner + drop "buyer list" eyebrow |
| `140ce57` | Score labels PascalCase |
| `38addb3` | Intake keyword pre-fill + FAQ rewrite |
| `d1daa97` | **P0**: confirm-and-pay migrated to `/manage/v1/citation-builder/{id}/confirm` PUT |
| `850a51b` | NAP audit tier gate (Pulse / Pulse+ / agency-managed only) to preserve BL Data API trial |
| `ab8d8be` | HANDOFF.md initial commit (this doc) |

## Files I'm actively editing

This worktree: `/Users/anthonyalfonsi/Claude/turfmap/.claude/worktrees/kind-albattani-957f10`
- Branch: `claude/kind-albattani-957f10` (tracks `origin/main`)
- Main repo at `/Users/anthonyalfonsi/Claude/turfmap` (push from worktree → main, then `vercel deploy` from main repo)

Key files touched across the session:
- `app/freescan/page.tsx` — VIP cohort lander
- `app/audit-upgrade/page.tsx` — Stage 2 click landing page (NEW this session)
- `app/order/success/page.tsx` — server-side cohort + saved-card + prefillKeyword lookup
- `app/order/success/OrderSuccessForm.tsx` — engagement hook + suppression gating
- `app/portal/[slug]/page.tsx` — dashboard suppression of AuditUpgradePanel for VIP cohort
- `app/api/checkout/[tier]/route.ts` — cohort discriminator from coupon, $0 gate on `setup_future_usage`
- `app/api/upgrade/audit/create-session/route.ts` — `source=stage_2_email` branch
- `app/api/cron/crmvip-stage2/route.ts` — Stage 2 email cron (every 15 min)
- `app/api/prospect/[id]/engaged/route.ts` — engagement stamp endpoint
- `components/email/CrmStage2AuditUpgradeEmail.tsx` — Stage 2 React Email template
- `components/marketing/AuditUpgradePanel.tsx` — onSkip, savedCard, inline 1-click
- `lib/brightlocal/citationBuilder.ts` — Management API migration (create + confirm + poll)
- `lib/stripe/leadOrders.ts` — persist cohort/prospect_id in stripe_metadata (merge on conflict)
- `lib/stripe/session.ts` — `LoadedSession.cohort` field
- `supabase/migrations/0026_prospects_cohort.sql` — cohort + Stage 2 trigger columns (NEW)
- `supabase/migrations/0025_prospects_business_name_check.sql` — SMOKE TEST prefix CHECK
- `scripts/add_one_prospect.py` — one-off prospect-add tool (NEW) at `~/Claude/Projects/Lead Generation/scripts/`

## Failed experiments / dead ends I burned time on

These are the rabbit holes that didn't pan out, so the next session doesn't repeat them:

- **BL Stoplight docs via WebFetch** — SPA-rendered, doesn't return content. Use Chrome MCP to navigate `developer.brightlocal.com/docs/management-apis/...` instead.
- **Reading the Superhuman shared-conversation link** — Superhuman's `mail.superhuman.com/teams/.../l/<id>` URLs deeplink to the Mac app or Chrome extension. Neither readable from MCP. Workaround: search the same thread via Gmail MCP (the user's Superhuman is on top of Gmail), then read the underlying email thread.
- **Filling Stripe Checkout via Claude-in-Chrome** — Stripe Checkout pages are hard-blocked. Always need the user to type card details themselves (test card `4242 4242 4242 4242` works in test mode).
- **Filling the post-Stripe business intake form via batched form_input** — Runtime sometimes misclassifies it as Stripe payment entry and rejects the batch. Workaround: smaller batches OR have the user fill it.
- **Resize browser to 375px for mobile QA** — Chrome MCP's `resize_window` has an effective floor of ~606px logical CSS pixels. All Tailwind responsive breakpoints from `sm:640` are still inactive so layouts are equivalent, but iPhone-tight text-wrap testing requires real device or DevTools Protocol.
- **Mapbox autofill on Vercel preview URLs** — token has URL restrictions blocking `*.vercel.app`. Type a literal address; the form accepts it. Not a code bug.
- **Initial /v4/cb/create + /v2/cb/confirm-and-pay flow** — both endpoints partially deprecated post May 10. Sugar Daddy campaign 965489 got stuck in BL "Saved" state because confirm-and-pay silently 4xx'd. Now fixed in commit `d1daa97`; old campaign still stuck pending user clicking "Start Campaign" in BL dashboard.
- **Cohort persistence in `lead_orders.stripe_metadata`** — `ensureLeadOrder()` only wrote 5 fixed fields, dropped the `cohort` from session metadata. First smoke test showed dashboard still rendered audit upsell for VIP cohort because of this. Fixed by adding `cohort` + `prospect_id` to the persisted metadata + adding a merge-on-conflict path for existing rows (commit `b0086cf`).
- **`preview_score` as float in `add_one_prospect.py`** — Supabase rejected with `invalid input syntax for type integer: "0.0"`. The column is INTEGER, not numeric. Cast to `int(round(score))`.
- **Lib imports in `add_one_prospect.py`** — Lead Generation project uses unqualified imports (`import config` not `import lib.config`). Put `lib/` itself on `sys.path`, not the project root.
- **First run of `add_one_prospect.py` keyword `landscaper`** — Mississauga landscaping local pack returned only sponsored entries (Google paid block). Re-ran with `landscaping company` keyword override — same result. Two real businesses surfaced (Mississauga Lawn Services, MVR Landscaping and Interlocking) but both at <1% share. Diagnostic verdict: no entrenched organic competitor in this niche → opportunity pitch for Justina.

## Outstanding work (pending operator action — NOT code)

1. **Send Stage 1 to 29 VIP prospects** via Superhuman snippets. CSV at `~/Claude/Projects/Lead Generation/vip_stage1_email_list.csv`. Justina's row is the 29th (last). Recommended snippet template + variable list provided in the prior message. Justina specifically needs a custom snippet (no `top_competitor_name`) — opportunity-framing pitch drafted.
2. **Send the Gmail draft to Connie Higgins (BL Sales)** sitting in your Drafts folder. Subject: `Re: [BrightLocal] Re: API Access`. The body answers her 3 discovery questions and asks for Data API per-request pricing + volume-tier options. Pricing details about the Pulse+ rate are deliberately scrubbed.
3. **Start Sugar Daddy campaign 965489 in BL dashboard** — currently parked in "Saved" state. User explicitly chose to defer until cold-email automation winds down + BL credit visibility improves. Now safer to defer because the NAP audit gate (commit `850a51b`) means free TurfScans no longer burn BL trial credits.
4. **Stripe VIP coupon in test mode** — only live mode confirmed. Optional, not blocking.

## BrightLocal account state

- **Account:** trial API key (`BRIGHTLOCAL_API_KEY` in Vercel prod env, set 9 days ago)
- **Management APIs (Citation Builder):** unlimited on trial per Rhea — Citation Builder feature on Pulse+ has $0 marginal cost
- **Data API (NAP audit):** 250-request trial cap; HARD STOP, no auto-bill. Each NAP audit = ~3-10 requests. Now gated to recurring tiers only.
- **Sales contact:** Connie Higgins (currently asking discovery questions before quoting per-request Data API pricing). Awaiting reply once user sends the prepared Gmail draft.
- **Citation Builder credit balance:** unknown — separate pool from Data API trial. Sugar Daddy campaign 965489 sits in "Saved" state; clicking "Start Campaign" would bill against this balance.
- **Open campaigns in BL dashboard:** Sugar Daddy Doughnuts (965489, Saved, never started). Plus several smoke-test locations from May 10-11 (location IDs 4061311, 4061331, 4061328, 4061327, 4061326, 4062832) worth cleaning up.

## Open code todos (low priority, post-launch)

- **GA4 cohort events** (P2 deferred) — `crm_reactivation_lander_view`, `crm_reactivation_purchase`, `crm_reactivation_audit_upgrade` events. Funnel reporting currently works via SQL queries against `prospects` + Stripe metadata.
- **First Pulse+ buyer = first real E2E test of Citation Builder** — smoke-test endpoint passed but the production path (`/manage/v1/citation-builder`) wasn't probed yet. Watch first real Pulse+ buyer's campaign closely.
- **Sample heatmap on cold-email-converted `/yourmap` "already done" state** — works correctly but no end-to-end re-test after the score-card casing fix.

## Next step I'd take

The campaign is ready for Stage 1 send. The code path was end-to-end smoke-tested on production with `vipsmoke02` (test prospect now cleaned up) — every step worked including post-suppression cohort detection, $0 checkout, engagement endpoint, Stage 2 cron fire, audit_upgrade URL redirect to Stripe.

**Recommended next-session pickup order:**

1. **Visual-verify `/freescan?prospect_id=ay62UUG9SE&coupon=VIP&utm_*=...`** (Justina's URL) handles `top_competitor_name=null` cleanly. Should skip "The Competition" card or render the soft "no entrenched competitor — opportunity" framing. Quick screenshot check is enough.
2. **Once Connie replies with Data API pricing**, evaluate whether to take a commercial key OR keep the NAP audit gate permanently. If pricing is reasonable (<$0.10/audit), re-enable for one-time tiers by reverting `850a51b`. If expensive, keep the gate and consider it a permanent feature differentiator.
3. **First Pulse+ buyer = first real E2E test of Citation Builder.** Smoke-test endpoint passed (`{ok:true, ...}` on May 12 ~12am) but the production path (`/manage/v1/citation-builder`) wasn't probed yet. Watch the first real Pulse+ buyer's campaign closely: confirm campaign creates, photo uploads work, confirm-and-pay returns 200 from the new PUT endpoint, polling cron updates per-directory state.
4. **Stage 2 conversion validation.** Once a real VIP buyer engages, watch them flow through the auto-fired Stage 2 email → audit upgrade Checkout → $197 redirect. This is the campaign's revenue moment — the only point we haven't validated against a real user.

Nothing technical blocking Stage 1 send right now.

## Useful one-liners for the next session

```bash
# Funnel state for VIP cohort
SELECT cohort,
  COUNT(*) AS prospects,
  COUNT(*) FILTER (WHERE converted_at IS NOT NULL) AS converted,
  COUNT(*) FILTER (WHERE scan_engaged_at IS NOT NULL) AS engaged,
  COUNT(*) FILTER (WHERE stage_2_sent_at IS NOT NULL) AS stage_2_sent,
  COUNT(*) FILTER (WHERE upgraded_to_audit_at IS NOT NULL) AS upgraded
FROM prospects
WHERE cohort = 'crm_reactivation_q2' GROUP BY cohort;

# Manually fire Stage 2 cron (after the 30-min engagement window)
cd ~/Claude/turfmap && \
  export CRON_SECRET=$(grep -E "^CRON_SECRET=" .env.production.local | cut -d= -f2- | tr -d '"') && \
  curl -X POST https://www.turfmap.ai/api/cron/crmvip-stage2 \
    -H "Authorization: Bearer $CRON_SECRET" -i

# Add another one-off prospect (edit args at top of main(), then run)
cd ~/Claude/Projects/Lead\ Generation && \
  .venv/bin/python3 scripts/add_one_prospect.py
```

## Environment notes

- Worktree: `~/Claude/turfmap/.claude/worktrees/kind-albattani-957f10/`
- Push to main from worktree: `git push origin HEAD:main`
- Deploy preview from main repo: `cd ~/Claude/turfmap && git pull && vercel deploy --yes`
- Production: `https://www.turfmap.ai`
- Supabase project: `nwzgbpoaufzznemrqecz`
- Lead-gen scripts: `~/Claude/Projects/Lead Generation/` (Python; venv at `.venv/`)
- BrightLocal trial API key (in `BRIGHTLOCAL_API_KEY` env): also used for Citation Builder, which is unlimited per Rhea
