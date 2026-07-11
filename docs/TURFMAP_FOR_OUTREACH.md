# TurfMap.ai — Inner Workings & Scoring (for outreach)

> **Purpose of this document**: brief another agent that's writing a cold-email acquisition campaign for Local Lead Machine (the agency offer that wraps TurfMap). The cold-email writer needs to understand the product mechanics and scoring well enough to (a) write copy that sounds like an operator wrote it, not a generic SaaS pitch, (b) reference specific metrics by name without confusing them, and (c) construct subject lines and CTAs that anchor on the diagnostic value.
>
> Tone notes: the actual product copy is direct, slightly self-deprecating, and refuses generic SEO pitch phrases. ("Worst case: $99 confirms it. Best case: you find a quick fix that pays for itself in one new customer.") The cold email should pattern-match this voice — operator-to-operator, not vendor-to-prospect.

---

## 1. What TurfMap actually is

**One-sentence pitch**: TurfMap runs an 81-point geo-grid scan across a local business's service area and shows them, cell by cell, where they appear in Google's local 3-pack — including where they're invisible.

**Why it exists** (the founder framing, useful for cold-email problem statements):

> "Off-the-shelf rank trackers told our clients they ranked #1 from their office and didn't mention they were invisible 3km down the road. So we built one that does."

**Who it's built for**: local service businesses where physical proximity dictates leads — plumbers, HVAC, roofers, electricians, dentists, healthcare practices, restaurants, retail. Anything that depends on the local 3-pack.

**Brand architecture (don't confuse the two)**:
- `turfmap.ai` — the app. Where buyers/clients log in.
- `localleadmachine.io` — the marketing/sales site for the productized agency offer (the cold-email destination).
- TurfMap is **not** sold as a standalone SaaS. It's the moat for Local Lead Machine. Treat it as proprietary tech that only LLM clients access.

**Built by**: Fourdots Digital, a Toronto agency doing local SEO for service businesses since 2018.

---

## 2. The scan mechanic (how the data is collected)

Every TurfMap scan does this, end to end, in under a minute:

1. Generate **81 GPS coordinates** in a 9×9 grid centered on the client's pin location, fanned out across their service area (default 1.6 mi half-width → 0.4 mi spacing between adjacent cells).
2. Fire **81 parallel real Google local-pack queries** through DataForSEO — one per coordinate. Each query returns the actual 3-pack Google would show a real searcher standing at that GPS point.
3. For each cell, record: did the client business appear? At rank 1, 2, or 3? Who else was in the pack?
4. Store all 81 cells, compute the metrics, generate the AI Coach playbook, deliver.

**Key facts a cold-email writer should know**:
- Real Google searches, not estimates or simulations. Each scan = 81 actual local-pack API calls.
- Grid is centered on the business's pin and scaled to their service radius. A multi-location operator gets a separate grid per location.
- "Local 3-pack" = the three Google Maps results at the top of a local search. Most valuable real estate in local search; businesses that land there capture the majority of clicks/calls.
- Works anywhere Google's local 3-pack works — US, Canada, UK, Australia, EU, most of the world.

**The visual artifact**: an 81-cell heatmap. Each cell color-coded by rank — lime (#1–3, "in the pack"), yellow (4–10), orange (11–20), red (21+ or absent).

---

## 3. The scoring system — the part the cold-email writer most needs to understand

TurfMap returns four computed numbers per scan. They're all derived from the same 81-cell rank array, but they tell different stories. **Reference them by their canonical names — they're trademarked-feeling and clients learn them.**

### 3.1 TurfReach — coverage (0–100%)

> "How much of your area you cover."

**Formula**: `cells_in_pack / 81 × 100`, where `cells_in_pack` = the number of cells with rank 1, 2, or 3.

**What it tells you**: of the 81 search points around your business, what % see you in the 3-pack at all.

**Bands**:
| TurfReach | Label |
|---|---|
| <20% | Invisible |
| 20–40% | Patchy |
| 40–60% | Solid |
| 60–80% | Dominant |
| 80%+ | Saturated |

**Cold-email anchor**: "A TurfReach of 35% means two-thirds of nearby searchers don't see you when they search for your service." That sentence converts.

### 3.2 TurfRank — rank quality (0.0–3.0)

> "Where you sit when you do appear."

**Formula**: `4 − avg_rank_in_cells_where_present`. Returns null when the business doesn't appear anywhere.

**Examples**:
- Always #1 across all in-pack cells → avg 1.0 → TurfRank **3.0**
- Always #2 → TurfRank **2.0**
- Always #3 → TurfRank **1.0**

**What it tells you**: independent of coverage, when you DO show up, where in the 3 slots are you sitting?

**Bands**:
| TurfRank | Caption |
|---|---|
| <1.0 | Edge of pack |
| 1.0–1.5 | Bottom-pack |
| 1.5–2.0 | Mid-pack — room to climb |
| 2.0–2.5 | Solid position when you appear |
| 2.5–3.0 | Strong / position #1 |
| null | Establishing baseline (no appearances) |

### 3.3 TurfScore — composite headline (0–100)

> "The one number you can quote, track, and improve."

**Formula**: `TurfReach × (TurfRank / 3)`

**Examples**:
- Reach 100, Rank 3.0 → **100** (#1 in every cell — never seen)
- Reach 100, Rank 2.0 → ~67 (always #2 across full territory)
- Reach 35, Rank 2.6 → ~30 (decent rank but two-thirds invisible)
- Reach 0 → **0**

**Bands** (canonical — used in dashboard, portal, PDF, AI Coach prompt, marketing):

| TurfScore | Label | Tone |
|---|---|---|
| 0–20 | Invisible | critical |
| 20–40 | Patchy | weak |
| 40–60 | Solid | solid |
| 60–80 | Dominant | strong |
| 80–100 | Rare air | elite |

**Real-world distribution** (useful for cold-email credibility): "Most local businesses we scan land between 30 and 55 before optimization. Above 60 is uncommon — it usually means the Google Business Profile is well-tuned and the citations are clean."

### 3.4 Momentum — change vs. previous scan (signed integer)

**Formula**: `current_TurfScore − previous_TurfScore` (rounded to integer).

**Captions**:
| Momentum | Caption |
|---|---|
| ≥ +10 | Strong territorial expansion |
| +1 to +9 | Growing |
| 0 | Holding steady |
| −1 to −9 | Contracting — investigate |
| ≤ −10 | Significant pullback — urgent review |
| null | First scan / no comparable prior |

Computed against the most recent scan **at least 12 hours older** (so same-day rescan jitter doesn't pollute the trend).

### 3.5 The diagnostic logic (what cold-email subject lines can tease)

The TurfScore × TurfRank pair is the strongest signal. The AI Coach reads it like this — and the cold-email writer can borrow the same framing:

| Pattern | Translation | Lever |
|---|---|---|
| Low TurfScore + **high** TurfRank (e.g. 16 + 2.6) | "Wins where it shows up, doesn't show up enough" | Reach is the bottleneck → prominence (reviews, citations, neighborhood content) |
| Low TurfScore + low TurfRank (e.g. 8 + 1.2) | "Fundamental prominence problem — fighting on weak ground everywhere" | Foundations first (GBP categories, services list, NAP cleanup) before reach extension |
| High TurfScore + **high** TurfRank (e.g. 70 + 2.5) | "Strong all around" | Defense + adjacent expansion (radius, secondary keywords, satellite locations) |
| High TurfScore + lower TurfRank (e.g. 60 + 1.8) | "Broad presence but mid-pack" | Rank-quality work — reviews, GBP completeness — beats reach work |

---

## 4. Competitor analysis (what shows up alongside the scores)

Every scan also returns a **top-3 competitor table** for the territory:

For each unique competitor name observed in the 81 local-pack results:
- **AMR** (average map rank): their average position 1–3 across cells where they appeared
- **Top-3 %**: % of the 81 cells where they appeared in the 3-pack at all

Sorted ascending by AMR, top 3 returned. Pulse+ unlocks a **competitor heatmap overlay** so the operator can toggle and see their #1 competitor's territory next to their own.

Pulse+ also unlocks **manual competitor tracking** — the operator can pin up to 5 specific competitors instead of relying on auto-discovery from the 3-pack.

---

## 5. The AI Coach (the deliverable buyers actually quote)

After every scan, **Claude Sonnet 4** produces a structured strategic playbook:

- **Diagnosis**: one sentence identifying the primary visibility problem (proximity, prominence, or relevance).
- **Three prioritized actions** (HIGH/MEDIUM/LOW) — each is a 6–10 word action plus a one-sentence rationale tied to the data.
- **Projected 90-day impact**: one sentence projecting realistic movement.

**The grounding rule** — the part that differentiates it from generic SEO chatbots and is worth quoting in cold email:

> "Every recommendation cites the specific directories you're missing from, the inconsistencies in your business listing, and the moves that map to your industry. No generic SEO advice."

The AI Coach is forbidden by its own prompt from citing data it doesn't have (no "competitor X has 12 reviews" — there's no review data in the prompt). When NAP audit data IS present, it can cite specific directories ("Yelp shows the wrong phone, BBB has a stale street number") — and that grounding is the moat.

---

## 6. NAP audits and citation work (Pulse+ and one-time tiers)

**NAP** = Name, Address, Phone — the three pieces of business contact data Google cross-references across hundreds of directories (Apple Maps, Yelp, Bing, Yellow Pages, plus industry-specific: Angi/HomeAdvisor for home services, ZocDoc/Healthgrades for medical, OpenTable/Tripadvisor for restaurants).

**When NAP isn't consistent across those directories, Google trusts the listing less, which suppresses appearance in the 3-pack.**

**What TurfMap does with NAP**:
- The **Visibility Audit** tier ($499) and **Pulse+** subscription run a per-vertical NAP scan via BrightLocal across all directories specific to the trade.
- Findings categorized: matched, mismatch (fix), sibling_match (multi-location), unverified, missing-from.
- Pulse+ goes further: **builds and keeps business listings in sync** across 70+ directories on the client's behalf (Google, Apple Maps, Bing, Facebook + the major data networks) — NAP corrections propagate automatically from one profile update. Major platforms sync within days; full propagation across long-tail directories takes 4–6 weeks; score lift typically visible in scans starting week 4.

---

## 7. Tier structure (what to anchor offers around)

The buyer self-sorts into **two paths**:

### Path A — One-time audits (no recurring billing)

| Tier | Price | What you get |
|---|---|---|
| **TurfScan** | $99 one-time | 81-point scan, 1 keyword, TurfReach + TurfRank + TurfScore, auto NAP citation check, AI Coach playbook (3 actions), branded PDF, delivered <1 min |
| **Visibility Audit** ⭐ | $499 one-time | Everything in TurfScan + per-vertical NAP audit + competitor heatmap overlay (top 3) + 30-min strategist call (live competitor teardown) + branded PDF with strategist notes + 30-day automated re-scan |
| **Strategy Session** | $1,497 one-time | Everything in Visibility Audit + 3 scans (different keywords/services) + 3 competitor GBP teardowns with screenshots + 60-min strategy session + comparative report + 2 automated re-scans (60 + 90 days) |

**All three include**: 30 days of TurfMap Pulse free as an attach offer.

**Comparison anchor**: most agencies charge $1,500–$2,500+ before they'll even look at your map pack. TurfMap audits start at $99.

### Path B — Continuous monitoring (subscription)

| Tier | Monthly | Annual | What's in it |
|---|---|---|---|
| **TurfMap Pulse** | $39/mo | $31/mo ($372/yr, save $96) | Weekly automated scan, **3 keywords**, 1 location, full dashboard (TurfScore/Reach/Rank/Momentum), weekly competitor summary, email alerts on TurfScore movement of 5+ points, monthly automated PDF, AI Coach refreshed each scan |
| **TurfMap Pulse+** ⭐ | $99/mo *(3-month minimum)* | $79/mo ($950/yr, save $238 / 20%) | Everything in Pulse, plus: **10 keywords**, 12-month historical trend, Slack integration, Looker Studio + Sheets export, CSV export, **manual competitor tracking (up to 5)**, granular alerts (competitor entries, score drops, cell-level changes, momentum reversals), on-demand AI Coach refresh, **+ business listings built + kept in sync across 70+ directories (Google, Apple Maps, Bing, Facebook + the major data networks), NAP corrections propagate automatically from one profile update, always-on for the life of the subscription** |

**Pulse+ propagation honesty rail** (mandatory, surfaced on the marketing card and worth setting expectations on in cold email):
> "Major platforms (Google, Apple Maps, Bing, Facebook) sync within days. Full propagation across the long-tail directories takes 4–6 weeks. Score lift typically visible in scans starting week 4 onward."

**Pulse+ commitment**: monthly Pulse+ has a 3-month minimum (Stripe Subscription Schedule). Annual implicitly commits the buyer for 12 months. Cancellation in the committed phase takes effect at end of phase, not end of period.

**Multi-location pricing** (linear, no tier-jump tax):
- +$19/mo per additional location on Pulse
- +$29/mo per additional location on Pulse+

### One-line tier tagline (use this in cold-email subject/CTA testing)

> **"Pulse tells you what's broken. Pulse+ fixes it for you."**

---

## 8. What clients actually see (the deliverable, end-to-end)

**Agency dashboard** (`/clients/[id]`):
- 9×9 heatmap of the territory with rank-color cells
- TurfScore hero stat with band (Invisible / Patchy / Solid / Dominant / Rare air)
- TurfReach + TurfRank stat cards
- Momentum card (after first re-scan)
- Top-3 competitor table
- AI Coach panel (diagnosis + 3 actions + projected impact)
- Pulse+ only: Citations panel with per-directory live status

**White-label client portal** (`/portal/[slug]`):
- Same heatmap, same scores, client's logo in the header
- Read-only — no scan triggers, no internal cost data
- Sign-in via Supabase magic-link (gated to invited portal users)
- Now includes: subscription status + "Manage billing" (Stripe Customer Portal) + "Upgrade to Pulse+" button when on Pulse

**Branded PDF report**:
- Generated on demand or monthly via Vercel Cron
- Same metrics + heatmap + AI Coach playbook, agency-branded
- Pulse delivers monthly automated PDFs; one-time audits deliver one branded report on completion

**Alerts** (post-scan):
- Score movement (basic, Pulse): TurfScore moved by ≥ N points (configurable threshold)
- Weekly competitor summary digest (basic, Pulse): Mondays
- Competitor entries (Pulse+): a new brand entered the 3-pack
- Momentum reversal (Pulse+): positive ↔ negative flip
- Cell-level changes (Pulse+): per-cell movement summary (noisy, opt-in)
- Slack delivery (Pulse+): all enabled alerts also POST to a configured Slack channel

---

## 9. Cron schedule (what runs automatically)

| Cron | Schedule | What it does |
|---|---|---|
| `weekly-scans` | Mon 06:00 UTC | Re-runs scheduled scans for all subscription clients |
| `weekly-competitor-summary` | Mon 13:00 UTC | Sends the weekly competitor digest email |
| `monthly-pdf` | 1st of month 09:00 UTC | Generates + emails the monthly branded PDF report |
| `poll-citations` | Daily 12:00 UTC | Polls BrightLocal for citation status updates (Pulse+) |
| `reset-citation-quotas` | Quarterly | Resets the 3-onboarding + 3-quarterly free citation re-sync caps |

---

## 10. Tech stack (only relevant for credibility line in cold email)

- Next.js 15 + TypeScript + Tailwind v4 + shadcn/ui
- Supabase (Postgres + Auth + Storage with RLS for multi-tenant safety)
- DataForSEO Local Pack API (~$0.0006/request standard queue, $0.002/request live mode)
- Anthropic Claude Sonnet 4 for the AI Coach
- Vercel hosting + Vercel Cron
- Stripe Checkout + Customer Portal + Subscription Schedules (for Pulse+ minimums)
- Resend for transactional email
- BrightLocal for NAP audits (Citation Tracker); GoHighLevel Listings (Uberall engine) for the Pulse+ listings sync — replaced BrightLocal Citation Builder 2026-07-11 (no location cap, $30/mo wholesale per sub-account)

**Cost discipline note** (a credible operator detail): every DataForSEO request logs `dfs_cost_cents` to the scan row. Unit economics are tracked from day one.

---

## 11. Distinctive language and phrases (steal for cold email)

These phrases are load-bearing in the marketing copy. Reusing them in cold email creates pattern-match continuity from email → landing page:

- **"You checked your rank once. From your office. That's one search out of 81."**
- **"81-point geo-grid scan."**
- **"Cell by cell, where you appear in Google's local 3-pack."**
- **"You rank #1 in 12 cells, #2 in 14, #3 in 11, and don't appear at all in 44." Now you know the shape of your territory."**
- **"Where you dominate, where you fade, and where your competitors own the conversation."**
- **"Pulse tells you what's broken. Pulse+ fixes it for you."**
- **"Worst case: $99 confirms it. Best case: you find a quick fix that pays for itself in one new customer."**
- **"By the agency that uses it on its own clients every day."**
- **"This isn't generic SEO advice — it's a read of your map."**
- **"Real searches. Real deliverable. Built by operators."**

---

## 12. Things to NOT say in cold email

- Don't claim the scan is "instant" without the qualifier "<1 minute" (dishonest).
- Don't promise score lifts in week 1–2 (citations propagate over 6–8 weeks; the marketing site is honest about this — the cold email should be too).
- Don't lump Pulse and Pulse+ together — Pulse+ is the action tier (listings built + synced across 70+ directories) and Pulse is monitoring only.
- Don't pitch TurfMap as a SaaS the prospect can self-serve into. The cold-email path is **into Local Lead Machine** (the agency offer) — TurfMap is the proof artifact / diagnostic that gets them to book.
- Don't use the phrase "multi-location claim flow" or other internal jargon (the AI Coach prompt explicitly forbids it; same applies to outbound copy).
- Don't reference review counts, GBP photos, post cadence, listing age, or backlink data — TurfMap doesn't measure those (yet) and inventing them is a fast way to lose credibility on the discovery call.

---

## 13. Suggested cold-email angles (for the writing agent to choose from)

**Angle A — The "one rank check" frame (broadest)**
Lead with: most rank trackers tell you one number from one location. TurfMap shows 81. Pivot to: a scan would take <1 minute and $99 to confirm whether they have a coverage gap or a rank-quality gap.

**Angle B — The competitor pocket frame**
Lead with: there's almost certainly a 1–2 km wedge of their service area where a competitor owns 100% of the 3-pack and they don't know it. Pivot to: a TurfMap scan finds the wedge.

**Angle C — The NAP citation chaos frame** (best for prospects with old/multiple business listings)
Lead with: most local businesses have 3–7 NAP inconsistencies across directories — wrong phone on Yelp, abbreviated address on Bing, stale suite number on BBB. Each one suppresses 3-pack visibility quietly. Pivot to: the Visibility Audit ($499) finds them per-directory and the AI Coach prioritizes the fix order.

**Angle D — The "from your office" frame** (good for local-pride markets)
Lead with: when you Google your service from your shop, you rank #1. From three blocks east, you don't appear at all. Most operators have never tested this. Pivot to: TurfMap tests it 81 times in under a minute.

**Angle E — The agency comparison frame** (best for operators evaluating SEO vendors)
Lead with: most agencies want $1,500–$2,500+ before they'll even look at your map pack. Pivot to: TurfMap's Visibility Audit is $499 and includes a strategist call. They can take the diagnosis to whoever they want.

---

## 14. Reference URLs

- App: `https://turfmap.ai/`
- Marketing landing (where audit CTAs land): `https://turfmap.ai/#section-04`
- Local Lead Machine (the cold-email destination): `https://localleadmachine.io/` and `https://fourdots.io/home-services`
- Built by: Fourdots Digital (`https://fourdots.io/`)
