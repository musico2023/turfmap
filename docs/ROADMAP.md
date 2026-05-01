# TurfMap Roadmap

Tracks deferred work that has scoping done but isn't built yet. Update as items
land or get re-prioritized.

## Up next

### NAP audit (Citation Health panel)

Make NAP (Name/Address/Phone) consistency checking part of the TurfMap product.
Pairs naturally with the geo-grid scan: heatmap shows the symptom (where the
client doesn't rank); NAP audit surfaces one of the root causes (citations
fragmented across directories, missing entirely from the highest-traffic
healthcare directories).

**Scope (locked):**

- Wrap a third-party citation API (probably **BrightLocal Local Citation
  Tracker** — has healthcare directories included, ~$0.50–$1 per audit). One
  module so we can swap providers later.
- New `nap_audits` table, modeled on `scans`:
  `id, client_id, audited_at, total_citations, inconsistencies (jsonb),
  missing_high_priority (jsonb), raw_response (jsonb)`.
- New API route `POST /api/nap/audit/[clientId]` — agency-gated.
  **Rate limit: 4 audits per client per month.** (Citations rot slowly; this
  is plenty.)
- Per-vertical directory list: a `vertical_directory_sets` config table or
  static map keyed by `clients.industry`-derived vertical
  (`healthcare` / `home_services` / `professional_services` / etc.). Each
  vertical has its own priority directory list — healthcare gets
  RateMDs/healthgrades-equivalent, home services gets HomeAdvisor/Angi,
  etc.
- Dashboard panel "Citation Health": total citations found, inconsistency
  count, top issues, list of missing high-priority directories.
- Trigger button (separate from scan trigger — NAP audits cost less so can
  be more frequent within the rate limit).
- **Feed the inconsistency data into the AI Coach prompt.** This is the
  single biggest win: closes the "Claude is guessing at root causes" loop
  by giving it actual structural data alongside the rank pattern. A
  practice with 14 NAP inconsistencies + 67/81 cells out-of-pack has a
  very specific, defensible diagnosis (NAP fragmentation hurting
  prominence-driven extension) — much better than current generic
  "improve reviews/photos" output.
- PDF report includes a Citation Health section.

**Deferred to v2 of this feature:**

- Cron-driven auto-audit (start with manual trigger only)
- Inconsistency fix-tracking UI ("mark fixed → confirm on next audit")
- Per-vertical config UI (start with hardcoded vertical map)

**Estimated build:** ~5–7 focused days for the first cut.

**Why it matters strategically:**

1. Generic NAP tools (Yext, Moz Local) skip healthcare directories. Including
   them is a real differentiator for the healthcare vertical.
2. Three legs of the offering — heatmap (where), NAP audit (one why),
   AI Coach (fix list) — is much harder to commoditize than just a heatmap.
3. Quarterly NAP re-audit is a natural recurring service that justifies
   recurring fees alongside re-scans.

### Schema migration to apply (low priority but real)

`supabase/migrations/0002_client_users_unique.sql` is committed but not yet
applied. Drops the buggy `UNIQUE(email)` on `client_users` and replaces with
`UNIQUE(client_id, email)`. Without it, a single email can only be on one
client portal at a time — fine for now (the agency-staff override on portal
routes covers the demo case) but eventually needed for consultants who
genuinely work with multiple clients.

Apply via Supabase SQL editor (project isn't connected to MCP).

## UI polish (small wins, do in batches)

### "100% pack presence" convergence badge

When TurfScore == Pack Strength on a client's dashboard, that's a
meaningful signal in itself: the business is in the local 3-pack at every
single grid cell, so the territory-coverage penalty never fires and the
two metrics collapse to the same number. First observed on Logik Roofing
(Oshawa, 1.6mi radius, 81/81 cells in pack, both scores = 91).

Today the dashboard renders the two scores as numbers without commentary,
which buries the signal. Add a small inline badge or callout when
`TurfScore === Pack Strength` (and Pack Strength is not null), reading
something like:

> ✓ **100% pack presence** — you appear in the local 3-pack at every
> point on the grid. The two scores converge because there's no absent-
> cell penalty to apply. Re-scan at a wider radius to find the edge of
> dominance.

Implementation notes:

- Component-side check in the StatCard wrappers (server component
  computes both, conditionally renders the badge under one or both
  cards).
- Edge case: if both are 0 ("—"), don't render the badge (that's the
  zero-presence case, opposite signal — TurfScore = 0 and Pack Strength
  = null/—, they're not "converged" they're both empty).
- Probably belongs on the agency dashboard AND the white-label portal.
- One-line CTA built in: "Scan at wider radius" button that re-runs the
  scan with `service_radius_miles × 2` (or some configurable expansion).
  This naturally surfaces growth opportunity for already-dominant
  clients. Could also be a dedicated "Find the edge of your turf"
  workflow.

**Estimated build:** ~30 min for the badge alone, ~2 hours if we wire the
"scan at wider radius" CTA.

## Already deferred (lower priority)

- Standard Queue for scheduled scans (3.3× cheaper than Live Mode at scale)
- Friendly slug column for `/portal/<slug>` URLs (currently UUIDs)
- Bulk client import (CSV)
- Slack/email TurfScore alerts (drop notifications when scores swing)
- Sentry integration
- Stripe webhook + subscription billing
- `supabase gen types` to replace hand-written `lib/supabase/types.ts`
- Styling sweep (function-over-form rule from CLAUDE.md)

## Eventually

- Mobile responsiveness (currently desktop-only by design)
- Competitor cell heatmap toggle improvements (sparkline of competitor
  presence over time)
- Trend-line forecasting (predict next-quarter TurfScore from review/citation
  velocity)
- Competitor onboarding wizard for the agency (so curated competitor lists
  scale beyond "manually edit a script per client")
