# Cold Email Architecture Pivot — Operator Runbook

**Date:** 2026-05-15 / 2026-05-16
**Branch:** `feat/marketing-tripwire`
**Status:** Backend shipped; awaiting (a) final email copy from marketing committee, (b) Anthony to create the Stripe coupon + Cal.com webhook config, (c) end-to-end test, then merge.

---

## 🚨 Known upstream enrichment gaps (2026-06-08)

The cold-prospect ingest is handled by an external pipeline (Instantly.ai / Apollo + custom enrichment scripts) — there is NO in-repo code that INSERTs into the `prospects` table. The pipeline silently drops several conversion-critical fields. Measured 2026-06-08 over the trailing 8 days:

| Field | Used by | Missing rate | Impact |
|---|---|---|---|
| `top_competitor_name` | `/yourmap` Competition card, cold-stage3 email | **~99.8%** | Buyer doesn't learn the named threat — biggest conversion lever on the hero |
| `top_competitor_share_pct` | `/yourmap` Competition card | **~99.8%** | No "winning 25% of your area" pressure |
| `city` | `/yourmap` hero copy, sample heatmap header, Competition card | **~17%** (~3,800/day) | Generic "your service area" fallback instead of city-specific |
| `trade` (truncated) | `/yourmap` fix-list copy, sample heatmap header, cold emails | **~3%** of historical rows | "this Landscap contractor" instead of "this Landscaping contractor" — backfilled 2026-06-08 via SQL but the source pipeline still produces them |

**Render-side mitigations shipped** (so the page doesn't embarrass us until the pipeline is fixed):
- `/yourmap` + `/freescan`: graceful empty-city fallbacks in headline copy + Competition card
- `/yourmap` + `/freescan`: Competition card now always renders for personalized prospects; falls back to curiosity-driving "someone's winning your area — the full scan names them" copy when name/pct are null
- `prospects.trade`: SQL backfill applied for high-confidence truncations (`Landscap` → `Landscaping`, `Dry` → `Drywall`, `Pest` → `Pest Control`, `Snow` → `Snow Removal`, `Pressure` → `Pressure Washing`, `Garage` → `Garage Door`, `Tree` → `Tree Service`, `Bee` → `Beekeeper`, `Window` → `Window Cleaning`, plus case-normalization of `hvac`/`roofer`/`plumber`/`landscaping`)

**What still needs an upstream fix** (outside this repo — chase in the external pipeline):
1. Competitor enrichment is effectively offline — needs to be reconnected so 99.8% of cold prospects start seeing real competitor names in the Competition card
2. City field gets dropped on ~17% of enriched rows — find the resolver path that's silently failing
3. Trade truncation source — looks like a `split(' ')[0]` or character-cap in the ingest script. Fix the source so future runs don't need SQL backfill

---

## What changed at a glance

Cold-email cohort transitions from **transactional ($49 TurfScan in body via MAPCHECK50)** → **reply-driven (free scan via COLDSCAN after positive reply, then free Visibility Audit + Cal.com booking offer)**.

Unchanged: `/fourdots` lander (FOURDOTS50), `/freescan` lander (VIP / `crm_reactivation_q2`), `/yourmap` lander (still functional with MAPCHECK50 for any in-flight or future channel).

---

## Files added on `feat/marketing-tripwire`

```
supabase/migrations/0028_prospects_cold_email_q2_cohort.sql
  → adds cohort='cold_email_q2_2026' to CHECK + new stage_3_sent_at column

lib/coupons/knownCoupons.ts
  → adds COLDSCAN entry (100% off TurfScan)

components/email/ColdReplyScanLinkEmail.tsx
  → Stage 2 reply-response email (delivered after positive reply)

components/email/ColdStage3AuditOfferEmail.tsx
  → Stage 3 email (offers free Visibility Audit + Cal.com)

app/api/admin/send-cold-stage2/route.ts
  → Operator endpoint for the manual Stage 2 send (Option B)

app/api/cron/cold-stage3/route.ts
  → Vercel Cron — fires Stage 3 emails 30min-24h after scan_engaged_at

app/api/webhooks/calcom-cold/route.ts
  → Second Cal.com webhook URL — handles cold-cohort bookings,
    bootstraps visibility_audits row for prospects who never paid
    for an audit upgrade

vercel.json
  → registers /api/cron/cold-stage3 on */15 * * * *
```

## Files modified in the sibling `Lead Generation` project (Anthony's lead-gen pipeline)

```
lib/config.py
  → default TURFMAP_LANDER_COUPON switched MAPCHECK50 → COLDSCAN
    (env override available: TURFMAP_LANDER_COUPON_OVERRIDE)

scripts/phase2_push.py
  → adds cohort='cold_email_q2_2026' to Instantly custom_variables
    (env override: PHASE2_COHORT)

scripts/update_instantly_sequence.py  (NEW)
outputs/cold_sequence_copy.template.json  (NEW)
  → Tooling to PATCH the Instantly campaign sequence in-place once
    marketing copy lands
```

---

## What Anthony still has to do manually

### 1. Create the COLDSCAN promotion code in Stripe (5 min)

Dashboard → Products → Coupons → New coupon:
- **Coupon code:** `COLDSCAN`
- **Type:** Percentage discount
- **Discount:** 100% off
- **Applies to:** TurfScan ($99) only (select the specific product / price)
- **Duration:** Once
- **Max redemptions per customer:** 1
- **Maximum redemptions (total):** 500
- **Expiry:** 90 days from creation
- **Description:** "Cold email reply-driven scan"

Then create a Promotion Code (the customer-facing wrapper) with the same `COLDSCAN` string attached to the Coupon. (Same pattern as MAPCHECK50, FOURDOTS50, VIP.)

### 2. Apply migration 0028 to Supabase

```bash
# Local
supabase db push
# Or: paste 0028_prospects_cold_email_q2_cohort.sql into the Supabase SQL editor
```

The migration is idempotent — safe to re-run.

### 3. Add the second Cal.com webhook

Cal.com → Settings → Developer → Webhooks → New webhook:
- **URL:** `https://turfmap.ai/api/webhooks/calcom-cold`
- **Events:** BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED
- **Secret:** Same value as `CAL_COM_WEBHOOK_SECRET` env var (re-use the existing one — the secret is shared across both webhooks)

The existing `/api/webhooks/calcom` webhook stays as-is. Both webhooks receive every event; each handler scopes itself by cohort (audit/strategy tier → main; cold_email_q2_2026 → cold). No event gets double-processed.

### 4. (When marketing committee lands the copy) Update Instantly sequence

```bash
cd ~/Claude/Projects/Lead\ Generation
cp outputs/cold_sequence_copy.template.json outputs/cold_sequence_copy.json
# Fill in step_0/1/2 subjects + bodies (HTML format with merge fields)
python3 scripts/update_instantly_sequence.py --copy outputs/cold_sequence_copy.json --dry-run
# Review diff. If OK:
python3 scripts/update_instantly_sequence.py --copy outputs/cold_sequence_copy.json --apply
```

Existing in-flight prospects who haven't received step 1 yet will get the new step 1 content automatically (Instantly serves the current sequence content at send time). Prospects who already received the old step 0 will get the new step 1 + step 2 — slight mixed-messaging window but acceptable per the brief.

### 5. Paste the new Stage 2 + Stage 3 copy

Replace the placeholder text in:
- `components/email/ColdReplyScanLinkEmail.tsx` (Stage 2)
- `components/email/ColdStage3AuditOfferEmail.tsx` (Stage 3)
- Also fill in `SUBJECTS` array in `ColdStage3AuditOfferEmail.tsx` with the brief's subject variants
- Also fill in `COLD_STAGE2_SUBJECT` in `ColdReplyScanLinkEmail.tsx`

Look for `PLACEHOLDER` markers — every spot needing copy is tagged.

### 6. Set new env vars (if not already set)

```
OPS_ADMIN_SECRET            # bearer for /api/admin/send-cold-stage2
COLD_STAGE3_CAL_URL         # default: https://cal.com/turfmap.ai/visibility-audit-walkthrough
```

`CAL_COM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL` already exist and are reused.

---

## End-to-end test plan (Deliverable #8)

Once everything above is in place:

1. **Push a test cold-email lead** through the lead-gen pipeline targeting a domain you control (e.g. a personal alias).
   ```bash
   cd ~/Claude/Projects/Lead\ Generation
   PHASE2_COHORT=cold_email_q2_2026 \
     python3 scripts/phase2_push.py push --in <test_csv> --live --yes --limit 1
   ```
2. **Verify the lead lands in Instantly** with `cohort: cold_email_q2_2026` in custom_variables.
3. **Wait for Email 1 to send** (or fire the campaign manually). Confirm body contains NO Stripe URL — only the "reply yes" CTA.
4. **Reply "yes"** from the test mailbox.
5. **Trigger Stage 2 manually:**
   ```bash
   curl -X POST https://turfmap.ai/api/admin/send-cold-stage2 \
        -H "Authorization: Bearer $OPS_ADMIN_SECRET" \
        -H "Content-Type: application/json" \
        -d '{"prospect_id": "<id>"}'
   ```
6. **Verify Stage 2 email** arrives with `/yourmap?prospect_id=...&coupon=COLDSCAN&utm_source=cold_email&utm_medium=warm_reply&utm_campaign=q2_2026`.
7. **Click the link → run the scan → view dashboard.** Confirm `scan_engaged_at` gets stamped on the prospect row.
8. **Wait 30+ minutes**, then trigger the cron manually:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://turfmap.ai/api/cron/cold-stage3
   ```
   Confirm the response includes `sent: 1` and `stage_3_sent_at` is now stamped.
9. **Verify Stage 3 email** arrives with the Cal.com booking URL.
10. **Book a Cal.com slot.** Watch Vercel logs for the `/api/webhooks/calcom-cold` POST. Confirm a `visibility_audits` row was created and `audit_call_status='booked'` got stamped.
11. **Verify the audit-milestones cron** (existing) picks up the new audit row and queues the 24h-pre-call prep email. The cold_cohort_pdf_buyer_suppressed metadata flag should prevent the buyer-facing PDF link from rendering (TODO: see Follow-up below).

---

## Known follow-ups (out of scope for this commit batch)

1. **Suppress the buyer-facing Roadmap PDF link in the Strategist Prep email** for cold cohort. The `cold_cohort_pdf_buyer_suppressed` flag is set on lead_orders.stripe_metadata by the calcom-cold webhook. The `StrategistPrepEmail` render path + the audit-milestones cron need a small check to honor it. Roughly:
   ```ts
   if (order.stripe_metadata?.cold_cohort_pdf_buyer_suppressed) {
     // Send the prep email without the PDF link section
   }
   ```
   This is per the brief: "PDF gets delivered to Anthony 24 hours before the call (not to the buyer)".

2. **OrderSuccessForm + portal page suppression for cold cohort.** The brief says cold cohort behaves like VIP in that audit upsell is suppressed. The existing suppression logic in `OrderSuccessForm.tsx` (`isWarmCohortForUpgradeGate`) checks `cohort === 'crm_reactivation_q2'`. Extend to also match `'cold_email_q2_2026'`. Same change in `app/portal/[slug]/page.tsx`'s `isWarmCohort`. Two-line edits each.

3. **Option C — NLP-based reply detection.** Stand up an Instantly webhook handler at `/api/webhooks/instantly-reply` that classifies positive replies and auto-invokes the existing `/api/admin/send-cold-stage2` endpoint. Defer until reply volume exceeds 10/day.

4. **Migrate in-flight cold-email prospects to the new sequence.** Per the brief, Anthony's call is "migrate." In-place sequence update (step 4 above) handles this for future steps. For step 0 — there's no migration since they've already received it. Optionally, mark in-flight prospects' `email_campaign` differently so reporting can attribute them.

---

## Reverting

If anything goes sideways in production:

1. **Revert Cal.com webhook:** Disable the `/api/webhooks/calcom-cold` URL in Cal.com settings. Existing one keeps working.
2. **Revert Instantly sequence:** Re-run `update_instantly_sequence.py` with the old copy (preserved in Instantly's revision history if available, otherwise restore from `outputs/sequences_before_patch.json` from the 2026-05-13 wave-2 work).
3. **Pause cold-stage3 cron:** Remove the entry from `vercel.json` and redeploy. The cron stops firing.
4. **Pause cold pushes:** Set `PHASE2_COHORT=cold_email` env var on the next pipeline run to restore the legacy transactional cohort.

The schema migration (0028) is additive — no need to revert; the new column + cohort value sit dormant.
