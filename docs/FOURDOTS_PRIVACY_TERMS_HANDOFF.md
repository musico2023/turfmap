# Fourdots.io privacy + terms — TurfMap-specific additions

Handoff brief for a separate Claude Code session working on the **fourdots.io** repo. Hand this whole file over; it's self-contained.

---

## Context — read first

You're updating the privacy policy and terms of service on **fourdots.io** to accurately describe a new product line: **TurfMap.ai**. Right now the marketing footer at `turfmap.ai` already links to `https://fourdots.io/privacy` and `https://fourdots.io/terms` — those pages exist but were written before TurfMap launched, so they probably don't mention TurfMap-specific sub-processors or billing terms.

**The single legal entity is Fourdots Digital.** TurfMap is one of its products — not a separate company. Privacy policy and terms describe the *operating entity*'s obligations across all properties (fourdots.io, turfmap.ai, anything else). Don't create separate `turfmap.ai/privacy` pages; consolidate everything at fourdots.io.

**What TurfMap actually is**: a geo-grid local-SEO product. Buyers (typically home-services businesses — plumbers, HVAC, roofers, restaurants) pay through Stripe Checkout; we run an 81-cell grid scan of their territory using DataForSEO's Local Pack API, generate a heatmap + AI Coach playbook, and either deliver a one-shot report (TurfScan / Audit / Strategy tiers) or recurring scans (Pulse / Pulse+ subscriptions). Pulse+ also includes citation building via BrightLocal.

**Tier matrix:**

| Tier | Price | Type | Includes |
|---|---|---|---|
| TurfScan | $99 | one-time | 81-point geo-grid heatmap, AI Coach playbook, branded PDF |
| Visibility Audit | $499 | one-time | Above + per-vertical NAP audit + competitor analysis + 30-min strategist call |
| Strategy Session | $1,497 | one-time | Above + 3-keyword scan + competitor deep-dives + 90-min strategist session |
| Pulse | $39/mo + $25/mo per additional location | subscription | Weekly automated scans, score-movement alerts, basic competitor tracking |
| Pulse+ | $99/mo + $35/mo per additional location | subscription | Above + citation building + Slack delivery + 10 keywords/location + granular alerts |

**Pulse+ monthly has a 3-month minimum commitment** (Stripe Subscription Schedule). Pulse+ annual and Pulse don't.

---

## Sub-processors — what to add to the privacy policy

The fourdots.io privacy policy needs to disclose every third party that touches buyer data when they use TurfMap. List these with short, accurate descriptions of what they receive.

### Required sub-processor disclosures

| Sub-processor | What we send | Why | Region |
|---|---|---|---|
| **Stripe Inc.** | Card details (handled by Stripe directly via Checkout — we never see the PAN), buyer email, billing address, business name | Payment processing for all paid tiers. Subscription management for Pulse / Pulse+. | US |
| **Resend** | Recipient email addresses + transactional email content | Order confirmation, scan-ready notifications, portal invites, Pulse+ welcome, Stripe Checkout links, weekly competitor digests, monthly PDF reports | US |
| **Supabase** | All buyer-provided business data (NAP, keywords, locations), all scan results, all derived metrics (TurfScore family, competitor leaderboards), Stripe customer/subscription IDs, AI Coach insights | Primary database and authentication backend for the application | US (default) — confirm region in Supabase dashboard if needed |
| **DataForSEO** | Business location coordinates (per grid cell, 81 cells per scan), tracked keyword strings, business name pattern (for own-business matching in results) | Google Local Pack SERP scraping at each cell of the geo-grid. We do NOT send buyer PII (email, phone, address-as-string) — only coordinates + keyword. | US/EU |
| **BrightLocal** *(Pulse+ only)* | Full NAP profile: business name, street address, city, region, postcode, country, phone, website, primary GBP category, additional categories, business description, hours, photo URLs | Citation building (submission to ~25 third-party industry directories on the buyer's behalf) and citation status tracking. Listings get propagated to those third-party directories — disclose this is meaningful onward sharing. | US/UK |
| **Anthropic PBC** | Business name + location label, the 81-cell rank grid (anonymized — just rank numbers per coordinate), top 10 competitor names observed in the scan, NAP audit findings (if available) | AI Coach playbook generation via Claude API. Anthropic operates zero data retention for API customers by default — prompts and responses are not retained beyond request processing. | US |
| **Mapbox** | Partial address strings (as the buyer types in autocomplete fields), buyer's IP address (for usage tracking on Mapbox's side) | Address autocomplete on onboarding forms — replaces the previous Nominatim-only flow. | US |
| **Cal.com** *(Audit + Strategy only)* | Buyer email, business name, optional notes | Strategist-call booking. Cal stores the booking + sends calendar invites. | US/EU |
| **Slack Technologies LLC** *(Pulse+ only, opt-in)* | Alert message bodies (TurfScore changes, competitor entries, etc.) — only when the buyer has connected a Slack workspace via OAuth | Pulse+ alert delivery to a buyer-chosen Slack channel. We post via incoming-webhook URL the buyer authorized. | US |
| **Vercel Inc.** | Server logs (IP, user agent, request path, response time), application code execution | Hosting and CDN for the application | US |
| **OpenStreetMap (Nominatim)** | Address strings (only for Mapbox-fallback paths) | Server-side geocoding fallback when Mapbox autocomplete isn't used | EU |

### Sub-processor list section — recommended structure

Add a section like this to the privacy policy. Suggested heading: **"Sub-processors and third-party services"**. Keep it factual; no marketing language.

```
We use the following third-party services to operate TurfMap. Each of
these has its own privacy policy; we link to each below. By using
TurfMap, you consent to the data flows described.

[For each sub-processor in the table above:]

  - <Name> (<Region>) — <one-line role>. We share <specific data
    fields> with them. <Link to their privacy policy>.

If we add new sub-processors, we'll update this list and notify
existing subscribers via email at least 30 days before the change
takes effect, except in cases where immediate change is required by
law or to prevent service disruption.
```

The sub-processor links to use:
- Stripe: https://stripe.com/privacy
- Resend: https://resend.com/legal/privacy-policy
- Supabase: https://supabase.com/privacy
- DataForSEO: https://dataforseo.com/privacy-policy
- BrightLocal: https://www.brightlocal.com/privacy-policy/
- Anthropic: https://www.anthropic.com/privacy
- Mapbox: https://www.mapbox.com/legal/privacy
- Cal.com: https://cal.com/privacy
- Slack: https://slack.com/trust/privacy/privacy-policy
- Vercel: https://vercel.com/legal/privacy-policy
- OpenStreetMap (Nominatim): https://wiki.osmfoundation.org/wiki/Privacy_Policy

### Existing privacy-policy sections to verify cover TurfMap

These are likely already in the fourdots.io privacy policy from when it was a pure agency-services site. Verify each handles the TurfMap case:

- **Information we collect** — should now mention scan results, geo-grid coordinates, business NAP data, AI-generated insights as data categories TurfMap collects.
- **How we use information** — should now mention "running geo-grid scans on your behalf," "generating AI-powered SEO recommendations," "submitting your business to citation directories" (Pulse+).
- **Cookies and analytics** — Vercel logs are operational, not analytics. If fourdots.io uses any analytics provider (Google Analytics, Plausible, etc.), confirm whether it's enabled on turfmap.ai too.
- **Data retention** — TurfMap stores scan history indefinitely by default. Buyers can request deletion via support. Should be stated.
- **User rights** — GDPR/CCPA/CASL access, deletion, portability rights apply equally to TurfMap data.
- **Contact** — same support email (presumably anthony@fourdots.ca / anthony@fourdots.io).

---

## Terms of service — what to add

### Subscription billing (Pulse / Pulse+)

Add a section covering:

1. **Recurring billing.** Pulse and Pulse+ are recurring monthly subscriptions billed via Stripe at the start of each billing period. The buyer authorizes recurring charges by completing Stripe Checkout.

2. **Pulse+ monthly minimum commitment.** Pulse+ on monthly billing cadence has a 3-month minimum commitment from the date of subscription. Cancellation requested during the committed phase takes effect at the end of the third month, not immediately. Pulse+ on annual cadence and Pulse (any cadence) have no minimum commitment beyond the active billing period.

3. **Cancellation.** Buyers can cancel at any time (subject to the Pulse+ monthly minimum above) via the in-app "Cancel" button on their portal, or directly through the Stripe Customer Portal. Cancellation takes effect at the end of the current billing period. Already-charged billing periods are not refunded on cancellation — the buyer retains full access through the end of the period they paid for. Refund eligibility on subscriptions follows the same scan-delivery-failure rule as one-time purchases below: if the first scan after subscription start fails to deliver within 7 days, the buyer may request a refund of the first month's charge. Subsequent months are not refundable.

4. **Per-location billing.** Each subscription includes one location. Additional locations are billed at $25/mo (Pulse) or $35/mo (Pulse+) per additional location, prorated daily. Adding a location triggers an immediate prorated charge for the partial period through Stripe. Removing a location applies a Stripe-issued proration credit against the buyer's next invoice for the unused portion of the current period — this is not a refund (no funds return to the original payment method); it offsets the next charge. The 3-month minimum commitment applies only to the base subscription, not to individual location line items.

5. **Pricing changes.** We may adjust prices with 30 days' written notice (via email to the address on file). Existing subscribers' rates lock at their current price for the remainder of their current billing period; the new price applies starting the next renewal.

6. **Trials.** When a free trial is offered (operator-initiated for agency-onboarded clients), the buyer authorizes their card to be charged at the end of the trial unless they cancel before then. Trial length is disclosed at Checkout.

### One-time products (TurfScan / Audit / Strategy)

Add a section covering:

1. **One-time charges.** TurfScan ($99), Visibility Audit ($499), and Strategy Session ($1,497) are non-recurring purchases. The buyer is charged once at Stripe Checkout.

2. **Strategist call (Audit + Strategy).** Visibility Audit includes a 30-minute strategist walkthrough; Strategy Session includes a 90-minute strategist deep-dive. Both are scheduled via Cal.com after purchase. The buyer must book within 30 days of purchase; calls scheduled past 30 days are at our discretion.

3. **Refund policy — TurfMap one-time purchases.** Refunds on TurfScan, Visibility Audit, and Strategy Session are limited to scan-delivery failure. Specifically:

   - **Eligible for refund:** if the buyer's initial scan has not been delivered to their dashboard within 7 days of Stripe Checkout completion, the buyer may request a full refund of the purchase price.
   - **Not eligible for refund (non-exhaustive):** scans that delivered successfully (regardless of the score result, ranking outcomes, or whether the buyer found the data actionable); strategist calls that were attempted, scheduled, or completed; failure to schedule a strategist call within the 30-day post-purchase window; dissatisfaction with AI Coach playbook recommendations; change of mind after a successful scan; results showing low visibility (TurfMap measures, it doesn't manufacture rankings).

   To request a refund under the scan-delivery-failure clause, the buyer emails support before the 7-day window closes. Refunds are processed to the original payment method via Stripe, typically within 5–10 business days.

4. **Failed-delivery remedy when refund isn't requested.** If a scan fails on our end and the buyer prefers re-delivery over a refund (e.g. the underlying business hasn't changed and they'd rather just have the data), we will re-run the scan at no charge. This is performance of the original purchase, not a separate service.

5. **Re-delivery for strategist calls.** If a scheduled Visibility Audit or Strategy Session call doesn't occur because of a TurfMap-side issue (strategist no-show, technical failure preventing the call), we re-schedule the call at no charge. This does not extend refund eligibility — the original 7-day scan-delivery refund window still applies and starts at Checkout, not at re-scheduled-call date.

### Data ownership and AI Coach disclaimer

Add:

1. **Buyer data ownership.** All business data the buyer provides (NAP, keywords, location info, hours, photos, categories) remains the buyer's property. We act as a processor; we use the data only to deliver the services purchased.

2. **AI-generated content is advisory.** TurfMap's AI Coach generates strategic recommendations grounded in the buyer's scan data. These recommendations are advisory — we do not guarantee specific ranking improvements, traffic gains, or business outcomes. The buyer is responsible for evaluating and implementing any recommendations.

3. **Citation building disclaimer (Pulse+).** Citation building submits the buyer's business information to ~25 third-party directories on their behalf. Directory acceptance, propagation timing (typically 2–8 weeks), and ongoing accuracy are subject to those third parties' policies and terms. We don't control directory acceptance or data accuracy at the destination.

### Service availability + scheduled scans

Add:

1. **Best-effort availability.** TurfMap operates on a best-effort uptime basis without a formal SLA. We rely on third-party services (Stripe, Supabase, DataForSEO, Vercel, Resend, Anthropic, BrightLocal) — outages there can interrupt scans, payments, or notifications.

2. **Scheduled scan timing.** Pulse and Pulse+ subscribers receive scheduled weekly scans via cron. The exact timing (typically Mondays at 06:00 UTC) is best-effort; we do not guarantee scan delivery on a specific clock time. Multi-location buyers may see scans staggered across the cron run window.

3. **Manual re-scans.** Subscribers can trigger an on-demand re-scan from their dashboard, subject to a 3-per-location-per-rolling-24-hour rate limit (to protect unit economics on Live Mode DataForSEO calls).

---

## Anchor IDs for the marketing footer

The TurfMap marketing footer at `turfmap.ai` links to:

- `https://fourdots.io/privacy`
- `https://fourdots.io/terms`

If you want TurfMap-landing buyers to scroll directly to relevant sections, add `id` anchors:

- `<h2 id="turfmap-data-flows">Sub-processors and third-party services</h2>` so the footer link can become `https://fourdots.io/privacy#turfmap-data-flows`.
- `<h2 id="turfmap-billing">TurfMap subscriptions and billing</h2>` for the terms version.

If you do this, ping back so I can update the marketing footer hrefs to use the fragment links.

---

## Style notes

- **Match fourdots.io voice.** TurfMap marketing copy is direct and operator-tone; legal copy should be clearer and more measured. Don't carry over marketing flourish into the privacy/terms additions.
- **No emojis.** Legal text only.
- **Plain links.** External links to sub-processor privacy policies should open in the same tab unless fourdots.io's existing pattern says otherwise.
- **Last-updated date.** Bump the "last updated" date on both pages when you make these changes.

---

## What NOT to do

- **Don't create `turfmap.ai/privacy` or `turfmap.ai/terms` pages.** Those would create legal-doc divergence. Keep the canonical legal docs at fourdots.io and let turfmap.ai link out.
- **Don't change the marketing-footer link target.** It's `https://fourdots.io/privacy` and `https://fourdots.io/terms` — leave that alone unless you're adding fragment anchors (above).
- **Don't reword existing fourdots.io legal text for TurfMap.** Add TurfMap-specific subsections; preserve the rest of the policy as-is. The agency services covered by fourdots.io still need their existing language.

---

## Suggested commit message

When you ship these updates on fourdots.io:

```
docs(legal): add TurfMap-specific sub-processors + billing terms

Closes the gap between the fourdots.io privacy/terms pages and the
TurfMap.ai marketing footer linking to them. Adds:

  - Sub-processors section listing 11 third parties TurfMap uses
    (Stripe, Resend, Supabase, DataForSEO, BrightLocal, Anthropic,
    Mapbox, Cal.com, Slack, Vercel, OSM) with what we share with each.
  - Subscription billing section covering Pulse / Pulse+ recurring
    charges, per-location billing, the Pulse+ monthly 3-month
    commitment, cancellation policy, and pricing-change notice.
  - One-time-product section covering TurfScan / Audit / Strategy
    refund posture and strategist-call scheduling.
  - AI Coach disclaimer (advisory, not guaranteed) and citation-
    building disclaimer (third-party directory acceptance).
  - Best-effort service availability + scheduled-scan timing notes.
  - Anchor IDs (#turfmap-data-flows, #turfmap-billing) for the
    marketing footer to link directly into the relevant sections.
```

---

## Quick verification checklist for the operator

After the fourdots.io session ships its update, run through these:

- [ ] Click "Privacy" in the turfmap.ai footer → confirms it opens fourdots.io/privacy
- [ ] Scroll through the page — TurfMap section is visible and accurate
- [ ] Each sub-processor link works (no 404s)
- [ ] Click "Terms" → same verification on fourdots.io/terms
- [ ] Subscription terms match the actual billing model (3-month minimum on Pulse+ monthly, etc.)
- [ ] Refund window matches what the operator actually wants to commit to
- [ ] "Last updated" date reflects the change

If any of those fail, send the gap back through the same channel.
