# TurfMap™ — Capability Inventory for Marketing Copy Audit

*Last verified against `feat/marketing-tripwire` HEAD (`6b600b4`). Anything claimed in copy that isn't on this list is aspirational and must be either built before launch or softened in copy.*

Each entry uses one of three flags:

- ✅ **Shipped** — works in production right now, you can demo it
- 🟡 **Partial** — exists but with caveats / requires manual operator action
- ❌ **Not built** — currently claimed somewhere in copy but doesn't exist

---

## 1. The scan itself

| Capability | Status | Notes |
|---|---|---|
| 81-point geo-grid scan (9×9) | ✅ | Fixed at 9×9 in v1 (per CLAUDE.md spec). Centered on the business address. |
| Service-area radius configurable | ✅ | Per-client + per-location (default 1.6 mi). Drives spacing of the 81 GPS coordinates. |
| Real Google local-pack queries | ✅ | DataForSEO Live SERP API. 81 actual queries per scan, run in parallel. |
| Scan completes in under a minute | ✅ | Live-mode parallelized. Real measured time: ~10–30s typical, capped at 5min function timeout. |
| Per-cell rank capture (#1 / #2 / #3 / not-in-pack) | ✅ | Stored in `scan_points` table. |
| Per-cell competitor capture (full local-pack) | ✅ | Every cell stores all 3 brands appearing in that cell's pack. |
| Cost tracking per scan (`dfs_cost_cents`) | ✅ | Internal — confirms unit economics, not user-facing. |

---

## 2. Metrics & scoring

| Metric | Status | Range / Definition |
|---|---|---|
| **TurfScore™** | ✅ | Composite 0–100 from Reach × Rank. Bands: Invisible / Patchy / Solid / Dominant / Rare air. |
| **TurfReach™** | ✅ | 0–100%. % of cells where the business appears in the 3-pack. |
| **TurfRank™** | ✅ | 1.0–3.0. Average position across cells where the business appears. |
| **Momentum** | ✅ | Signed delta vs. prior scan. Null on first scan, populated from second scan onward. |
| Score band labels w/ colored chip | ✅ | Renders on dashboard + portal + share view + PDF. |

---

## 3. AI Coach

| Capability | Status | Notes |
|---|---|---|
| AI-generated diagnosis paragraph | ✅ | Anthropic Claude Sonnet 4 via `@anthropic-ai/sdk`. Prompt is at v9 with NAP grounding + multi-location awareness + 7-day score history. |
| 3 prioritized action recommendations (HIGH/MEDIUM/LOW) | ✅ | Structured output. Each has a title + body. |
| Projected impact line | ✅ | One-sentence forecast at the bottom of the playbook. |
| Industry-specific recommendations | ✅ | Prompt receives the client's industry and adapts. |
| NAP-grounded recommendations (cites specific directories) | ✅ | When NAP audit data is present, AI Coach can name specific missing directories + inconsistencies. |
| On-demand AI Coach refresh | ✅ | Button exists on the dashboard. Not currently rate-limited per tier. |

---

## 4. Dashboard (agency-facing)

| Capability | Status | Notes |
|---|---|---|
| Live animated heatmap (reveal-from-center) | ✅ | Same `HeatmapGrid` component used on the marketing hero. |
| Three score cards (Score / Reach / Rank) | ✅ | TurfScore is the hero card with vertical fill bar. |
| Momentum card (second+ scans) | ✅ | |
| Competitor table (top 5 + expander for tracked-but-absent) | ✅ | |
| Heatmap competitor toggle ("Compare to competitor") | ✅ | Renders the competitor's cell pattern with a header-toggle. |
| Settings page (business details, NAP fields, keywords, locations, portal users) | ✅ | |
| Logo upload (Supabase storage, white-label) | ✅ | |
| On-demand re-scan button | ✅ | Rate-limited 3/24h per location. |
| PDF download | 🟡 | Endpoint requires agency auth (`requireAgencyUserForApi`). Self-serve buyers can't hit it directly — see §10. |
| Share-link generation | ✅ | |

---

## 5. Multi-location support

| Capability | Status | Notes |
|---|---|---|
| Multiple physical locations per client | ✅ | Built in migration 0006. |
| Per-location scan grid + keywords + competitors | ✅ | Each location is fully independent. |
| Location switcher (dashboard + portal + scans page) | ✅ | Searchable dropdown, scales to 50+ locations. |
| Per-location NAP audit | ✅ | Sibling-aware — if a sibling location is found at a directory, the active location is flagged "missing here, sibling has it" rather than "inconsistent." |
| Multi-location indication in URLs (`?location=<id>`) | ✅ | |

---

## 6. NAP audit (operator-internal)

| Capability | Status | Notes |
|---|---|---|
| BrightLocal Listings API integration | ✅ | Auto-fires when a scan completes (no operator click needed). |
| Per-vertical directory profile | ✅ | `lib/brightlocal/directories.ts` maps industry → relevant directory list (home services, medical, legal, restaurants, etc.). |
| Inconsistency detection (NAP mismatches) | ✅ | |
| Missing-from-directory detection | ✅ | |
| Sibling-match detection (multi-location) | ✅ | |
| Findings surfaced in AI Coach prompt | ✅ | Prompt v7+ grounds recommendations in actual NAP data. |
| Standalone NAP audit UI for operators | ❌ | Audits run silently in the background — no operator-facing audit page. (Current spec: AI Coach output references NAP findings; raw NAP report has no UI surface.) |

---

## 7. Competitor tracking

| Capability | Status | Notes |
|---|---|---|
| Automatic competitor discovery | ✅ | Default mode: every brand appearing in the scan's 3-pack populates the competitor table. |
| Manual curated competitor list (per-location) | ✅ | Operator can add specific brands to track even when they don't appear in the pack. |
| Competitor heatmap overlay | ✅ | Heatmap toggle shows the competitor's cell pattern. |
| Top-3 competitors in dashboard sidebar | ✅ | |
| Competitor share % calculation | ✅ | |

---

## 8. Scheduled scans

| Capability | Status | Notes |
|---|---|---|
| Vercel Cron weekly run | ✅ | Mondays 06:00 UTC. Authed via `CRON_SECRET`. |
| Multi-location aware | ✅ | One client × N locations × M keywords yields N×M scheduled scans. |
| Idempotent within a UTC day | ✅ | Won't double-fire if cron retries. |
| Scan-frequency configurable per keyword | 🟡 | DB supports `daily` / `weekly` / `biweekly` / `monthly`. **The cron only honors `weekly`.** Daily/biweekly/monthly are stored but not enforced. |
| Failure resilience (per-keyword try/catch) | ✅ | |
| Auto-NAP audit post-scan | ✅ | |

---

## 9. Re-scan rate limiting

| Capability | Status | Notes |
|---|---|---|
| 3 on-demand scans per location per 24h | ✅ | Both client-side button-disable AND server-side enforcement (returns 429). |
| "Daily limit reached" UI state with next-slot countdown | ✅ | |

---

## 10. PDF reports

| Capability | Status | Notes |
|---|---|---|
| Branded one-or-two-page PDF per scan | ✅ | Renders via `@react-pdf/renderer` (no Chromium dep). |
| Page 1: heatmap (vector SVG) + 4 score cards + top-3 competitors | ✅ | |
| Page 2: AI Coach playbook (diagnosis + 3 actions + projected impact) | ✅ | |
| Sensible filename (business + scan date) | ✅ | |
| **Endpoint requires agency auth** | 🟡 | `/api/reports/pdf?scanId=X` is gated. **Self-serve buyers** can't fetch their own PDF without operator action. **Marketing claim "PDF report you can keep or share" needs either a public-share PDF route OR an email-delivery flow added.** |
| White-label PDF reports (per-client branding switch) | ❌ | The PDF is "TurfMap-branded" everywhere today. Not parameterized by client/tier. **Marketing claim in Pulse+ needs this built.** |

---

## 11. Sharing (public read-only links)

| Capability | Status | Notes |
|---|---|---|
| Generate per-scan public share link | ✅ | Expiry options: 7 / 30 / 90 / 365 days. |
| Optional agency_label + ctaText + ctaUrl on the share page | ✅ | Per-link customization — operators can stamp "Shared by [Agency]" + a CTA. |
| Revocable any time | ✅ | |
| View count + last-viewed-at tracking | ✅ | |
| Auto-copy URL to clipboard on creation | ✅ | |
| Read-only public dashboard (no scan controls / cost data) | ✅ | |

---

## 12. White-label portal (`/portal/[slug]`)

| Capability | Status | Notes |
|---|---|---|
| Per-client public_id slug URL | ✅ | |
| Magic-link sign-in (Supabase Auth) | ✅ | |
| Membership-gated by `client_users` table | ✅ | |
| Agency-staff impersonation (with "Agency preview" tag) | ✅ | |
| Custom logo upload | ✅ | |
| Per-client brand-accent color | ❌ | **Recently removed** (clashed with the lime/dark instrument aesthetic). Logo-only white-label as of `polish/portal-drop-accent`. |
| Multi-location switcher in portal | ✅ | |

---

## 13. Email delivery

| Capability | Status | Notes |
|---|---|---|
| Magic-link emails (Supabase Auth) | ✅ | Supabase handles these natively. |
| Resend integration for transactional emails | ❌ | Listed in CLAUDE.md spec but **no `resend` dep installed and no email-sending code anywhere in the repo**. |
| "Your scan is ready" delivery email | ❌ | |
| Order-confirmation email after Stripe checkout | ❌ | The order-success page just shows "Scan firing now" in-browser. No email follow-up exists. |
| Monthly automated PDF report delivery (Pulse promise) | ❌ | PDF generation works; scheduled email delivery doesn't exist. |
| Email alerts on TurfScore movement of 5+ points (Pulse promise) | ❌ | No alert pipeline at all. |
| Weekly competitor movement summary (Pulse promise) | ❌ | |

---

## 14. Historical / trend view

| Capability | Status | Notes |
|---|---|---|
| Scan history table per location | ✅ | Lists all completed scans with date, score, reach, rank, status. |
| Dual-axis trend chart (TurfScore + TurfReach over time) | ✅ | Pure SVG, no charting lib. Renders all available scans (no fixed window). |
| 12-month historical trend view (Pulse+ promise) | 🟡 | Becomes literally true after 12 months of data exists. Today, TurfMap clients have ~weeks of data. **Marketing copy "12-month historical trend view" is technically achievable for any new buyer after 12 weekly scans, but is misleading on day 1.** |

---

## 15. Data exports

| Capability | Status | Notes |
|---|---|---|
| Looker Studio + Google Sheets export (Pulse+ promise) | ❌ | Zero export endpoints. |
| CSV raw data export (Pulse+ promise) | ❌ | |
| Public API for raw data | ❌ | No authenticated data API exposed. |

---

## 16. Slack / third-party integrations

| Capability | Status | Notes |
|---|---|---|
| Slack alerts to channel (Pulse+ promise) | ❌ | No Slack SDK, no integration code. |
| Webhook outbound for scan completion | ❌ | |

---

## 17. Stripe / billing / subscriptions

| Capability | Status | Notes |
|---|---|---|
| `/api/checkout/[tier]` Stripe Checkout session creator | 🟡 | Code exists for `scan` / `audit` / `strategy` / `pulse` / `pulse_plus`. Returns 503 with helpful inline error until env vars (`STRIPE_SECRET_KEY` + per-tier price IDs) are configured. |
| One-time payment mode | 🟡 | Wired but not yet runnable (no Stripe products created). |
| Subscription mode (Pulse / Pulse+) | 🟡 | Wired but not yet runnable. |
| Annual billing variants | ❌ | Marketing copy mentions "$31/mo billed annually" — no separate Stripe Price ID for annual; no cadence toggle on the cards. |
| 30-day Pulse trial-on-attach (audit purchase → free Pulse trial) | ❌ | Banner promises this; no code attaches a trial subscription to one-time payment sessions. |
| Per-location add-on pricing (+$19/mo / +$29/mo) | ❌ | No quantity/add-on price IDs configured. |
| Stripe webhook for subscription state sync | ❌ | No `/api/stripe/webhook` route exists. Subscription status would not be synced into the DB without one. |
| `clients.billing_mode` column (`one_time` / `self_serve_subscription` / `agency_managed`) | ❌ | Column doesn't exist; cron has no billing-mode gate. |

---

## 18. Self-serve buyer flow (post-Stripe-checkout)

| Capability | Status | Notes |
|---|---|---|
| Stripe success URL → `/order/success?tier=X&session_id=Y` | ✅ | Page renders with form. |
| Order confirmation form (business name, address, keyword, email, phone) | ✅ | |
| Form submission → `/api/orders/fulfill` | ❌ | **Form posts to a route that doesn't exist yet.** It returns 404; the form gracefully surfaces "Order intake isn't wired yet — email anthony@fourdots.io" as the fallback. Until built, every self-serve order requires manual operator handling. |
| Auto-create `clients` row + `tracked_keywords` row from form | ❌ | |
| Auto-fire scan after form submit | ❌ | |
| Email delivery of scan link | ❌ | |
| Strategist booking link (for $499 / $1,497) | ❌ | |

---

## 19. Analytics / observability

| Capability | Status | Notes |
|---|---|---|
| CTA click tracking (page → checkout) | ❌ | No analytics SDK installed (no PostHog, Plausible, GA, or Vercel Analytics). |
| Page view tracking | ❌ | |
| Stripe checkout abandonment tracking | ❌ | |
| Sentry error tracking | ❌ | Listed in CLAUDE.md spec; not installed. |

---

# 🚨 Marketing-copy claims that don't yet match reality

These are statements currently on the marketing page (or in the Pulse+ feature lists) that the inventory above shows as not-built. **Each one is either: (a) something to build before launch, (b) something to soften in copy, or (c) something to mark as "rolling out [date]".**

| Claim | Where it's stated | Reality |
|---|---|---|
| "Email alerts on TurfScore movement of 5+ points" | Pulse card | No alert pipeline exists. |
| "Weekly competitor movement summary" | Pulse card | Not built. |
| "Monthly automated PDF report" | Pulse card | PDF generation works, scheduled email delivery doesn't. |
| "12-month historical trend view" | Pulse+ card | Trend chart exists; "12-month" framing is only true after 12 months of accumulated scans. |
| "Slack integration — alerts and weekly summaries" | Pulse+ card | Not built. |
| "Looker Studio + Google Sheets data export" | Pulse+ card | Not built. |
| "CSV raw data export" | Pulse+ card | Not built. |
| "White-label PDF reports" | Pulse+ card | PDFs are TurfMap-branded only; not parameterized per-tier. |
| "Granular alerts (competitor entries, score drops, cell-level changes, Momentum reversals)" | Pulse+ card | No alert pipeline; would build on top of the foundational email alerts work. |
| "PDF report you can keep or share" | $99 / $499 / $1,497 cards | PDF endpoint is agency-auth-gated. Either need a public PDF route on share links, or operator manually emails post-scan. |
| "Buy any audit, get 30 days of Pulse free" | Attach banner | Not wired into Stripe Checkout. Honored manually until built. |
| "$31/mo billed annually (save 20%)" | Pulse / Pulse+ cards | No annual Stripe price ID + no cadence toggle. Monthly checkout only. |
| "+$19/mo per additional location on Pulse / +$29/mo on Pulse+" | Add-on callout | No quantity/add-on price IDs configured. |
| "After [Stripe payment] you'll fill in your business details and we'll fire the scan immediately" | Pricing intro | The form exists; the auto-fire endpoint doesn't. Manual operator step required today. |

---

# Suggested phasing if shipping the page imminently

**Build before the page goes public** (highest-stakes promises that buyers will test immediately):

1. `/api/orders/fulfill` — convert Stripe success → real `clients` row → auto-fire scan → email link
2. Resend integration + "Your TurfMap is ready" transactional email
3. Public PDF route (or attach PDF to the delivery email)
4. Stripe products + price IDs (one-times + 2 monthly tiers)

**Ship within 30 days of launch** (Pulse subscribers will expect these by their second scan):

5. Email alerts on score movement
6. Monthly automated PDF email delivery
7. Stripe webhook + `clients.billing_mode` migration
8. Cron support for non-weekly cadences (daily/biweekly/monthly)

**Ship within 60–90 days** (Pulse+ differentiators):

9. Annual billing variants + cadence toggle UI
10. White-label PDF (per-tier accent + branding)
11. CSV export endpoint
12. Slack integration
13. 30-day-trial-on-attach Stripe flow
14. Granular alerts (competitor entries, cell-level changes)

**Ship later** (lower urgency):

15. Looker Studio / Google Sheets export
16. Public data API
17. Analytics SDK (PostHog or similar)
18. Sentry error tracking

---

*This doc is current as of `feat/marketing-tripwire` HEAD. Re-run if anything ships in the meantime.*
