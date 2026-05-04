# TurfMap™ — Pre-Launch Buildlist

*Companion doc to [`CAPABILITY_INVENTORY.md`](./CAPABILITY_INVENTORY.md). The inventory is the truth-state of what ships today. This is the must-build list to make the marketing page's promises real.*

The marketing page (`feat/marketing-tripwire`) makes a few load-bearing promises that, if false on day one, will burn buyers and refunds:

1. **You pay** → Stripe Checkout works, accepts the right amount.
2. **You fill in business details** → form posts to a real endpoint that creates the scan.
3. **You get your map within minutes** → email arrives with a link.
4. **You can keep your PDF** → buyer can actually access it.
5. **For Pulse subscribers** → next month's scan fires automatically and a new map shows up.

Everything else can be softened in copy or labeled as "rolling out" without blocking launch. This buildlist covers the load-bearing ones.

---

## Launch readiness gate

The page should not redirect to public DNS until **every item under §1–§5 below is ✅**. The §6 items can ship in a follow-up PR within 7 days of launch — these are buyer-pain mitigations, not data-loss risks.

---

## §1. Stripe is live

Without these, every CTA on the pricing section returns a 503.

| Item | Owner action | Notes |
|---|---|---|
| Create Stripe products + recurring/one-time prices | Stripe Dashboard | Five products: TurfScan ($99 one-time), Visibility Audit ($499 one-time), Strategy Session ($1,497 one-time), Pulse ($39/mo recurring), Pulse+ ($89/mo recurring). |
| Set production env vars in Vercel | Vercel Dashboard | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PRICE_SCAN`, `..._AUDIT`, `..._STRATEGY`, `..._PULSE_MONTHLY`, `..._PULSE_PLUS_MONTHLY` |
| Enable Stripe Customer Portal | Stripe Dashboard → Settings → Customer Portal | Lets self-serve subscribers manage their billing without us building a settings page. Configure: cancel subscription enabled, payment method update enabled, billing history visible. |
| Set Customer Portal return URL to `https://turfmap.ai/portal/<slug>` (or wherever subscribers land post-cancel) | Stripe Dashboard | |
| `/api/stripe/webhook` route | **Build** | Handles `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Updates `clients.subscription_status`. ~150 lines. |
| Add Stripe webhook signing secret | Stripe Dashboard + Vercel env | `STRIPE_WEBHOOK_SECRET` |

**Estimated effort:** 1 dev-day. The webhook is the only meaningful code; the rest is dashboard configuration.

---

## §2. Database is ready for self-serve buyers

The current schema assumes every `clients` row is owned by an agency. Self-serve buyers need a billing-mode flag and Stripe identifiers.

| Item | Owner action | Notes |
|---|---|---|
| Migration `0008_billing_mode.sql` | **Build** | Adds: `clients.billing_mode` (`one_time` / `self_serve_subscription` / `agency_managed`, default `agency_managed`), `clients.stripe_customer_id`, `clients.stripe_subscription_id`, `clients.subscription_status`. Backfills existing rows to `agency_managed`. |
| Add `lead_orders` table | **Build** | Tracks each Stripe Checkout session: `id`, `stripe_session_id`, `tier`, `email`, `client_id` (nullable until form submitted), `status` (`paid` / `fulfilled` / `failed`), `created_at`. Lets us audit + recover if `/api/orders/fulfill` is ever offline when a buyer arrives at the success page. |
| Update `requireAgencyUserOrRedirect` callers in agency console to filter by `billing_mode = 'agency_managed'` (optional) | **Build** | Without this, self-serve `clients` rows show up in the agency console's client list. May actually be desirable as a "leads queue" view; design call. |

**Estimated effort:** 0.5 dev-day. Migration + small route update.

---

## §3. The order-fulfillment pipeline (the critical path)

This is the part that converts "buyer paid" → "buyer has a TurfMap." Without it, every self-serve order requires Anthony manually firing scans by hand.

### `/api/orders/fulfill` (POST)

| Item | What it does | Notes |
|---|---|---|
| Validate Stripe session_id | Confirm payment completed via Stripe API lookup. Reject replays. | Server-side defense — the session_id alone is not proof of payment. |
| Geocode the submitted address | Use existing `/api/geocode` (Nominatim). | Already exists — just call it. |
| Create the `clients` row | `business_name`, `address`, `lat`, `lng`, `industry`, `service_radius_miles` from the form; `billing_mode` from the tier; `stripe_customer_id` from the session. | Reuses logic from `/api/clients/route.ts` minus the agency-auth gate. |
| Create the primary `tracked_keywords` row | One keyword for `scan` / `audit` / `pulse`. Three for `strategy` / `pulse_plus`. `scan_frequency = 'weekly'` for subscribers, `'monthly'` (or whatever cron supports) otherwise. | |
| For audit/strategy buyers, queue an internal Anthony notification | Send Resend email to `anthony@fourdots.io` with order details. | Manual strategist scheduling kicks off from this. |
| Trigger the scan | Reuse `runScanForLocation` from `lib/scans/runScan.ts`. | Currently only callable from agency-authed contexts; needs a system-level entry point. |
| Mark the `lead_orders` row as `fulfilled` | | |
| Return scan_id so the success page can poll for completion | | |

**Estimated effort:** 2 dev-days. This is the heaviest piece of work. Most of the building blocks exist; the orchestration is new.

---

## §4. Email delivery (Resend)

Without email, even a successful scan goes nowhere. The buyer waits, gets nothing, refunds.

| Item | What it does | Notes |
|---|---|---|
| `npm i resend` | Install dep | |
| `RESEND_API_KEY` in Vercel env | Set up Resend account, verify sending domain (probably `mail.turfmap.ai`). | |
| `lib/email/client.ts` | Resend SDK wrapper, single shared instance. | ~30 lines. |
| `lib/email/templates/scanReady.tsx` | Transactional email — "Your TurfMap is ready" with link to public-share view + PDF link. Uses `@react-email/components`. | First template. |
| `lib/email/templates/orderConfirmation.tsx` | Sent immediately after Stripe checkout success — confirms purchase, sets expectation ("we're scanning now"). | |
| `lib/email/templates/strategistInbound.tsx` | Internal email to anthony@fourdots.io for $499 / $1,497 orders. | |
| Hook into `runScanForLocation` post-success: send `scanReady` email when buyer's scan completes | **Build** | Only fires for `billing_mode != 'agency_managed'` (don't email Kidcrew's portal users every time their cron scan finishes). |

**Estimated effort:** 1.5 dev-days. Resend setup is fast; templating the three emails takes the time.

---

## §5. PDF reports are reachable by the buyer

Today `/api/reports/pdf?scanId=X` is agency-auth-gated. Self-serve buyers can't fetch their own PDF.

**Two implementation options — pick one:**

### Option A: Attach PDF to the delivery email *(recommended)*

| Item | What it does | Notes |
|---|---|---|
| When the scan-ready email is sent, render the PDF + attach as `application/pdf` | **Build** | Resend supports attachments natively. PDF buffer comes from existing `renderToBuffer(<TurfReport ... />)`. |
| No new public route needed | | Existing agency-auth gate stays in place. |

**Pros:** simpler, more visceral ("the report is in your inbox"), no new public attack surface, no PDF-hosting infrastructure.

**Cons:** if the buyer loses the email they need to ask us for a re-send.

### Option B: Public PDF endpoint behind a share-link

| Item | What it does | Notes |
|---|---|---|
| New route `GET /api/share/[id]/pdf` | Gates by share-link existence + non-revoked + non-expired. Renders the same TurfReport. | |
| Surface the PDF link on the share page | | |

**Pros:** buyer can re-fetch any time.

**Cons:** more code, a new gated public endpoint, share-link revocation impacts PDF access.

**Recommendation: Option A for launch, Option B as follow-up if buyers ask for re-fetch.**

**Estimated effort:** 0.5 dev-day for Option A.

---

## §6. Subscriber lifecycle (Pulse / Pulse+)

These items are required for Pulse subscribers to *not have a broken second month*. They can ship within 7 days of launch — the first month's scan is delivered by the order-fulfill flow above; only the *second* monthly scan needs this scaffolding.

| Item | What it does | Notes |
|---|---|---|
| Update cron to gate on `billing_mode` | Skip `one_time` clients (or only run their bundled re-scans). Run `self_serve_subscription` clients only when `subscription_status = 'active'`. | ~20 lines added to `app/api/cron/weekly-scans/route.ts`. |
| Update cron to honor non-weekly cadences | Currently filters `scan_frequency = 'weekly'` only. Need to also fire `monthly` on the right day-of-month, etc. | A separate `monthly-scans` cron may be cleaner than retrofitting one cron. |
| Pulse subscribers' magic-link sign-in | Reuse the existing `/portal/[slug]` flow. Self-serve subscribers see exactly what agency clients see. | Subscriber's `clients.public_id` becomes their portal slug; `client_users` row created at order-fulfill time using the email from Stripe. |
| Send `pulseScanReady` email each completed monthly/weekly scan | Different template than `scanReady` — references their subscription, includes "manage" link to Stripe Customer Portal. | |
| Failed-payment recovery | When Stripe webhook fires `invoice.payment_failed`, send a "your card was declined, here's how to update it" email pointing at Stripe Customer Portal. | |

**Estimated effort:** 1.5 dev-days.

---

## §7. Strategist call scheduling

For $499 and $1,497 buyers, the marketing page promises a strategist call. Without a scheduling link, the manual back-and-forth eats Anthony's time.

| Item | Owner action | Notes |
|---|---|---|
| Pick a scheduling tool | Cal.com (open source) / Calendly / Savvycal | Cal.com has the cleanest embed, no per-call pricing on the open source self-host. |
| Create event types | `30-min Visibility Audit walkthrough` (for $499) and `90-min Strategy Session` (for $1,497) | |
| Embed the link in the order-confirmation email for those tiers | **Build** | Personalized URL per buyer (Cal.com supports prefilling email + name). |
| Surface the link on `/order/success?tier=audit` and `?tier=strategy` after form submit | **Build** | Optional — most buyers will use the email link, but the success page is a redundant safety net. |

**Estimated effort:** 0.5 dev-day. Tool setup + 2 template tweaks.

---

## Total estimate

**~7 dev-days for everything in §1–§7.** Critical path is §3 (order-fulfill pipeline) since everything else depends on it.

If this is one developer working full-time: **roughly 1.5 weeks before launch is safe.**

If the buildlist must compress: **§1, §3, §4, §5 (Option A) is the absolute minimum** — about 5 dev-days. §2 can mostly defer to using Stripe metadata instead of a `clients.billing_mode` column for week-1, but you'll regret that within the first month. §6 can defer until the first Pulse subscriber's second month rolls around (~30 days post-launch) — though if a subscriber's second scan never fires you'll have a real refund situation.

---

## Recommended launch sequence

If you want to launch incrementally to de-risk:

### Phase A: $99 only (Day 0)

Open just the TurfScan tier publicly. The other tiers' CTAs return a "coming soon, email us" message. Validates:

- The page converts at all
- The order-fulfill pipeline holds up under real traffic
- Email delivery doesn't break
- Buyers actually use the PDF
- Refund rate is acceptable

If anything blows up here, you only owe $99 refunds. ~1 week of operating time before opening Phase B.

### Phase B: $99 + $499 + $1,497 (Day 7–14)

Add the human-strategist tiers once the scheduler is wired and you've confirmed your written-diagnosis turnaround can really hit 2 business days. Higher-stakes refunds ($499 / $1,497) so wait until the lower tier is humming.

### Phase C: + Pulse $39/mo (Day 21+)

Open the monthly subscription once §6 is live and you're sure the second-month scan reliably fires. Subscribe-then-broken is the worst possible UX.

### Phase D: + Pulse+ $89/mo (Day 30+)

Open Pulse+ only after at least one Pulse+ differentiator has shipped (e.g. weekly scans + 12-week trend view). At $89/mo buyers will look hard at what they're getting; "everything in Pulse" alone won't justify 2.3× the price.

### Phase E: defer indefinitely

- Annual variants, per-location add-ons, attach trial — wait for demand signal
- Slack / Looker / CSV exports — only build when an actual buyer asks
- White-label PDF — only build when an agency / channel partner asks

---

## What I'd do this week

If I were prioritizing my own time:

1. **Day 1–2:** Build §3 (order-fulfill pipeline) end to end with a Stripe test-mode product. Test by buying my own $99 scan in test mode end-to-end.
2. **Day 3:** Build §4 (Resend integration + scanReady email + PDF attachment). Re-test the full buy → email → PDF loop in test mode.
3. **Day 4:** Apply §2 migration. Rerun the full loop with `billing_mode` semantics. Manual pass on the agency dashboard to confirm self-serve clients show up clearly.
4. **Day 5:** Wire production Stripe products (§1). Do a real live test with a real $99 charge to my own card. Refund myself. Confirm webhook fires + database state is correct.
5. **Day 6:** Set up Cal.com (§7), test booking flow end-to-end on a $499 test purchase.
6. **Day 7:** Open §6 (cron billing-mode gating + monthly cadence). Pulse subscribers' second month is now safe.
7. **Day 8:** Launch Phase A ($99 only) publicly. Watch logs / Resend deliverability / Stripe events for 24h.
8. **Day 10:** If Phase A's clean, open Phase B ($499 + $1,497).
9. **Day 21:** Phase C (Pulse $39).
10. **Day 30:** Phase D (Pulse+ $89), only if at least one Pulse+ differentiator is live.

---

*This doc is current as of `feat/marketing-tripwire` HEAD (`6b600b4`). Update as items ship.*
