# AI Visibility Module: Dev Evaluation

**Responds to:** "TurfMap: AI Visibility Module" concept (Anthony, 2026-09-13)
**Status:** evaluation complete, Phase 0 spike script included in this branch
**Verdict:** **GO on Phase 0**, with the spike redesigned around what we learned below. **NO-GO on the concept as costed** (weekly, 3 engines, 25 points, k=5 per prompt) because raw API cost exceeds the price of every tier we sell. A reshaped product survives the math; details in §3 and §7.

---

## 0. TL;DR for the five decisions

| # | Decision | Answer |
|---|---|---|
| 1 | DataForSEO coverage vs building adapters | DFS covers all four engines. Use DFS for everything in Phase 0 and Phase 1. Build a direct adapter only if Phase 0 shows DFS location targeting is not good enough for ChatGPT (§2). |
| 2 | Real per-scan cost at 10 / 25 / 49 points | See §3. Headline: the Google surfaces (AI Overview, AI Mode) are cheap and coordinate-targeted. The LLM engines are 10-50x more expensive per call and dominate the bill. |
| 3 | Entity extraction | Two-stage: deterministic target match first (reuse `nameMatches` + citation-domain match), LLM extraction with a strict Zod schema only for the competitor set. Validate against a 150-answer hand-labelled set before any number reaches a dashboard (§4). |
| 4 | Effort | Phase 0: script is in this branch, 2 days of operator time to run and read. Phase 1 MVP: 3 to 4 focused weeks (§6). |
| 5 | Schema / renderer blockers | No hard blockers. `scans` and `scan_points` should not be reused (wrong grain). `HeatmapGrid` needs a value-mode generalization, about half a day (§5). |

---

## 1. What production already tells us

I pulled read-only samples from the production Supabase project before writing anything.

**Current unit economics (last 60 days, 1,275 complete scans):**

| Metric | Value |
|---|---|
| DFS cost per 81-point scan | 16 cents, flat, every scan |
| Wall clock per scan | ~41 s |
| Implied DFS spend | roughly $100/month at current volume |

That is the bar the AI module has to be measured against. Pulse is $39/mo and Pulse+ is $99/mo. A module whose raw API cost is $150/client/month, as the concept memo estimated, cannot ride on either tier.

**Google's AI surface already varies by grid cell.** The 81 SERP responses we store per scan include the `ai_overview` element when Google shows one. In the most recent 4,000 stored grid points:

| Observation | Count |
|---|---|
| Points with an AI Overview element in the SERP | 205 of 4,000 (5.1%) |
| Scans (n=49, 60+ points each) with AI Overview in some cells but not others | 41 |
| Scans with AI Overview in every cell | 0 |
| Scans with no AI Overview anywhere | 8 |
| Max cells with AI Overview inside one scan | 45 of 81 |

Same keyword, same minute, same city: Google decides cell by cell whether to show an AI answer. That is direct evidence that at least one AI surface is geo-sensitive at the resolution of our grid, which is the premise the memo said could kill the concept in week one. It does not yet prove that *who gets named* varies by cell, only that the surface itself does. Phase 0 measures the second part.

Two caveats on that data. First, 148 of the 206 AI Overview items are async placeholders (`asynchronous_ai_overview: true`, no content) because we never asked DFS to wait for the AI Overview to load. The other 58 carry inline text and a `references[]` list with source URLs, which is exactly the citation-mining payload. Second, 5% is the trigger rate for short commercial keywords like "plumber toronto". Question-shaped prompts ("who is the best plumber in Leslieville") trigger AI answers far more often, so the spike uses prompts, not keywords.

---

## 2. Engine layer: DataForSEO covers it

Short answer to decision 1: DataForSEO covers all four engines, and it covers them two different ways. Which way matters more than which engine.

| Engine | DFS route | Location targeting | Citations returned | List price per call |
|---|---|---|---|---|
| Google AI Overviews | Already in our organic SERP response (`ai_overview` item). Add `load_async_ai_overview: true` to the existing 81-point call so the content loads instead of the placeholder. | **Coordinates** (`location_coordinate`, same as today) | Yes, `references[]` with url / domain / title | Marginal on a call we already make. Async load surcharge not verified; §3 models it at the full $0.002 live price as a ceiling |
| Google AI Mode | `serp/google/ai_mode/live/advanced` and the standard queue | **Coordinates** (`location_coordinate` as `lat,lng,15z`; a zoom level, not the radius form the organic endpoint takes) | Yes, `references[]` | $0.004 live, about $0.0012 standard (quoted as 2x organic) |
| ChatGPT (consumer UI) | `ai_optimization/chat_gpt/llm_scraper` (scrapes the real web UI through DFS proxies) | **City** (`location_code` / `location_name` from the DFS location DB) | Yes: `sources[]` (cited), `search_results[]` (retrieved), plus `brand_entities[]` and a `chat_gpt_local_businesses` block that DFS extracts for us | $0.0012 standard, $0.004 live |
| ChatGPT (API) | `ai_optimization/chat_gpt/llm_responses/live` with `web_search: true` | **City string** (`web_search_country_iso_code` + `web_search_city`) | Yes, `annotations[]` with url / title | $0.0006 + OpenAI pass-through, about $0.015 with web search on gpt-4.1-mini |
| Perplexity | `ai_optimization/perplexity/llm_responses/live` (sonar models search by default) | **Country** only through DFS. Perplexity's own API accepts lat/lng, but its Sonar endpoint retires 2026-09-27 and moves to their Agent API | Yes, `annotations[]` | $0.0006 + pass-through, about $0.007 on sonar at low context |
| Gemini (consumer UI) | `ai_optimization/gemini/llm_scraper` | **City** | Yes | $0.0012 standard, $0.004 live |
| Gemini (API) | `ai_optimization/gemini/llm_responses/live` with grounding | None. Google Search grounding has no location parameter | Yes | $0.0006 + pass-through, about $0.015 to $0.036 depending on model |

Three things fall out of that table.

**The Google surfaces are coordinate-targeted and nearly free.** AI Overviews ride the scan we already run at every one of the 81 cells. AI Mode is a second SERP-priced call. Both accept the exact `location_coordinate` string `lib/dataforseo/client.ts` already sends. For these two engines the "geo-context injection" problem in the memo's §6 does not exist: we are measuring what Google serves at that coordinate, not a text hint.

**The consumer-UI scrapers are the right ChatGPT and Gemini source.** They cost a tenth of the API route, return what a real user sees (the memo's "retrieval source differs per engine" point is about the consumer apps, not the API), and take a city-level location. City is coarser than a cell, so for these engines a 5×5 grid over one city collapses to one real location plus a neighbourhood string in the prompt. That is the validity gap the memo describes, and Phase 0 tests whether the prompt string moves the answer.

**Standard queue, not Live.** Every DFS route above has a `task_post` / `task_get` form at a third of the Live price. The Google scan uses Live because 81 calls fit in a request. AI scans will not fit in a request anyway (§5.4), so they get the cheaper queue for free.

**Build vs buy:** buy. Do not write direct OpenAI, Perplexity, or Gemini adapters in Phase 0 or Phase 1. The only case for one is Perplexity's native lat/lng targeting, and that is a Phase 0 experiment (compare DFS country-level Perplexity against a direct call with coordinates on the same cells), not a Phase 1 commitment. No consumer UI scraping of our own: DFS carries that ToS and breakage exposure, which is what we pay them for.

**Pricing verification caveat.** All DFS, OpenAI, Perplexity, and Gemini figures above come from the vendors' published pricing pages as indexed on 2026-09-13, not from a signed quote. DFS raised prices about 20% on 2026-07-01 and the $0.002 organic Live figure is confirmed post-increase by our own production cost rows (16 cents per 81 points, every scan, through September). The AI Optimization figures should be confirmed against the DFS dashboard before Phase 1 pricing is locked. The spike script reads cost from the provider's response, so Phase 0 replaces every estimate with a measured number.

---

## 3. Cost model

All figures are per client, per scan, in raw API cost, using the list prices in §2. "Per month" assumes weekly refresh (4.33 scans). Grids are 3×3, 5×5, 7×7 because `grid.ts` requires an odd size; 9 cells stands in for the memo's 10.

Unit-cost assumptions used below: ChatGPT API via DFS $0.015; Perplexity via DFS $0.007; Gemini grounded API $0.015; ChatGPT scraper $0.0012 standard; AI Mode $0.0012 standard; AI Overview $0.002 marginal (ceiling); Claude Haiku extraction $0.0045 per answer, or $0.008 per cell-prompt when the k answers are batched into one call.

### Design A: the memo as written

Five prompts, k=5, three engines through their API routes, one extraction call per answer.

| Cells | Calls per engine | ChatGPT | Perplexity | Gemini | Extraction | Per scan | Per month |
|---|---|---|---|---|---|---|---|
| 9 | 225 | $3.38 | $1.57 | $3.38 | $3.04 | **$11.36** | $49.20 |
| 25 | 625 | $9.38 | $4.38 | $9.38 | $8.44 | **$31.56** | $136.67 |
| 49 | 1,225 | $18.38 | $8.58 | $18.38 | $16.54 | **$61.86** | $267.86 |

The memo's own estimate ($37.50 per scan, $150 per month at 25 cells) is close. Against Pulse at $39/mo and Pulse+ at $99/mo, this design is dead on arrival at every grid size. Note also that extraction is a quarter of the bill: the LLM pass over free text costs almost as much as asking the question.

### Design B: recommended

Google surfaces on the grid (AI Overview piggybacked on the 81-point scan, AI Mode at k=2 because it is a SERP, not a chat), ChatGPT through the consumer-UI scraper on the standard queue, Perplexity through DFS, three prompts, k=5 for the LLM engines, extraction batched per cell-prompt. Gemini deferred to Phase 2.

| Cells | AI Overview | AI Mode | ChatGPT | Perplexity | Extraction | Per scan | Per month weekly | Per month biweekly |
|---|---|---|---|---|---|---|---|---|
| 9 | $0.16 | $0.06 | $0.16 | $0.95 | $0.65 | **$1.98** | $8.58 | $4.30 |
| 25 | $0.16 | $0.18 | $0.45 | $2.63 | $1.80 | **$5.22** | $22.59 | $11.32 |
| 49 | $0.16 | $0.35 | $0.88 | $5.15 | $3.53 | **$10.07** | $43.60 | $21.85 |

Perplexity is now the single most expensive line because it is the one engine with no scraper route, and it only targets by country through DFS. If Phase 0 shows Perplexity answers do not move with the neighbourhood string, run it once per city instead of once per cell and the 25-cell scan drops to about $2.80.

### Design C: entry tier

Google surfaces only. No LLM extraction because AI Overview and AI Mode return structured `references[]`, so the target match is a domain match plus `nameMatches` on the answer text.

| Cells | AI Overview | AI Mode | Per scan | Per month weekly |
|---|---|---|---|---|
| 9 | $0.16 | $0.06 | **$0.23** | $0.98 |
| 25 | $0.16 | $0.18 | **$0.34** | $1.48 |
| 49 | $0.16 | $0.35 | **$0.51** | $2.23 |

This is cheaper than the Google scan itself and can ship inside Pulse at no price change. It is also the version whose geo claim is fully honest.

### Where this lands against pricing

| Tier | Price | Google scan cost today (weekly, 1 keyword) | Design C added | Design B at 9 cells, biweekly | Design B at 25 cells, weekly |
|---|---|---|---|---|---|
| Pulse | $39/mo | $0.69 | $1.48 | $4.30 | $22.59 |
| Pulse+ | $99/mo, 3 keywords | $2.08 | $1.48 | $4.30 | $22.59 |

A tiering that works: Design C in Pulse (one line on the existing dashboard: "AI Overview mentions you in 12 of 81 cells"), Design B at 9 or 25 cells biweekly in Pulse+, and 25 or 49 cells weekly as a priced add-on or inside the Strategy tier. The free acquisition scan in the memo's Phase 3 is one city-level ChatGPT scraper call plus one AI Mode call at the business pin: under two cents.

### Levers, ranked by how much they move the number

1. Scraper routes instead of API routes for ChatGPT and Gemini (10x on those lines).
2. Batch extraction per cell-prompt, dedupe identical answers before extracting, skip extraction entirely on the Google surfaces (3x on the extraction line).
3. Standard queue instead of Live (3x on every DFS line).
4. k=2 on AI Mode and any engine that Phase 0 shows to be stable run to run.
5. Biweekly refresh (2x).
6. Cache identical (engine, location, prompt) within the refresh window. This matters for multi-location clients whose grids overlap.
7. Fewer prompts. Three is the floor for a rate that means anything.

Coarser grid is deliberately not on this list as a cost lever. It is a validity decision (§7), and Design B is already affordable at 25 cells.

---

## 4. Entity extraction

The failure mode to design against is the one the memo names: a naive matcher produces garbage. We already paid for that lesson on the Google side, where a first-word regex credited "Clear Works" rankings to "Clear Choice Windows & Doors" and inflated a TurfScore from 10 to 24 (see the comment block in `lib/scans/runScan.ts`). Do not repeat it.

### 4.1 Target mention (the headline number)

Deterministic, no LLM, two independent signals, either one is a hit:

1. **Name containment.** `nameMatches(canonical, answerText)` from `lib/citations/napCompare.ts`, run against the answer text with the GBP display name and the operator-typed business name as canonicals (same dual-name trick `runScan.ts` uses, because they routinely disagree). It is forward containment over filler-stripped tokens at a 0.75 bar, already hardened for single-word brands, load-bearing stopwords, and franchise names. Tighten it for free text by requiring the matched tokens to fall inside a 12-token window, otherwise a long answer that mentions "Toronto" and "plumbing" 40 tokens apart counts as a hit for "Toronto Plumbing Co".
2. **Citation domain match.** The client's website domain appearing in the answer's cited URLs. This is near-zero false positive and catches the "linked but paraphrased" case the name matcher misses.

Record which signal fired. In the labelled-set evaluation, report precision and recall separately per signal and combined.

### 4.2 Competitor set (share of voice)

This is where extraction is non-trivial. Recommended approach, in order of preference:

- **Provider-extracted entities first.** The ChatGPT and Gemini scraper responses carry `brand_entities[]` and a `chat_gpt_local_businesses` item with structured listings. AI Overview and AI Mode carry `references[]` with domains. For those engines the competitor set comes from structured fields and the LLM pass below is a cross-check, not the source. Phase 0 records both so we can measure how complete DFS's own extraction is.
- **LLM extraction with a strict schema.** One Claude Haiku call per answer, `output_config: { format: zodOutputFormat(...) }`, the exact pattern `lib/ai-coach/generateInsight.ts` already uses. Schema: `{ businesses: [{ name, is_local_business: boolean, ordinal: number, cited_url: string | null }] }`. Temperature 0. Cost is a fraction of a cent per answer (§3).
- **Prior from the Google scans.** Every client already has a competitor universe in `scan_points.competitors` (names, domains, place ids) from their 81-point scans. Fuzzy-match extracted names against that set first with `cleanCompetitorName` + `nameMatches`. A name that matches a known local-pack competitor is high confidence. A name that matches nothing becomes a "new in AI" competitor, which is itself a finding worth surfacing (businesses that AI recommends but Google's pack does not).
- **Batch it.** Extraction runs after the engine calls, over all k runs of a cell in one prompt where they fit, which cuts the call count by roughly k.

### 4.3 Validation gate

Before any number renders:

- Hand-label 150 answers from the Phase 0 CSV (about 90 minutes of operator time): target mentioned yes/no, list of business names, which are local competitors.
- Ship gate: target-mention precision at or above 0.97, recall at or above 0.90. Competitor extraction F1 at or above 0.85.
- Keep the labelled set in `scripts/fixtures/` and add a `verify-ai-mention-match.ts` to the `npm run verify` chain, the same way every other matcher in this repo is guarded.

### 4.4 Version stamping

Every run row stores `engine`, `model_name` as returned by the provider, `adapter_version`, and `extractor_version` (mirror `LLM_FIT_SCORE_VERSION` in `lib/audit/llmFitScore.ts`). Trend lines filter on these so a provider model swap shows as a discontinuity, not as a client's visibility collapsing.

---

## 5. Schema and renderer: what blocks reuse

### 5.1 Schema

Nothing blocks the module, but the existing tables are the wrong grain and should not be reused.

- `scans.scan_type` has a CHECK constraint limited to `scheduled` and `on_demand`, `grid_size` defaults to 9, and `total_points` is set to 81 by `runScan.ts`. Extending it with a `surface` column would work mechanically, but every reader (`turfReach`, `turfRank`, `composeTurfScore`, momentum, alerts diff, the weekly competitor summary, the PDF) assumes a scan row is a Google local-pack scan with 81 cells and rank semantics.
- `scan_points` has one row per cell with `rank integer` and `business_found boolean`. The AI module's atomic unit is a *run* (engine × cell × prompt × repetition), and citation mining needs run-level rows to join on. Collapsing k runs into one cell row throws away the data that sells the product.
- `dfs_cost_cents` on `scans` is the cost-discipline convention. Keep it, but the AI module has two cost sources (DFS and Anthropic extraction), so store both.

Proposed tables, one migration:

```
ai_scans        id, client_id, location_id, prompt_set_id, grid_size (3|5|7),
                status, engines text[], reps_per_cell, total_runs, failed_runs,
                dfs_cost_cents, extraction_cost_cents, started_at, completed_at
ai_scan_runs    id, ai_scan_id, engine, model_name, adapter_version, grid_x, grid_y,
                latitude, longitude, place_label, prompt_variant, rep_index,
                answer_text, citations jsonb, extracted jsonb, target_mentioned bool,
                target_signal text, target_ordinal int, cost_cents numeric, latency_ms,
                raw_response jsonb, created_at
ai_scan_cells   ai_scan_id, engine, grid_x, grid_y, runs, mentions, mention_rate,
                avg_ordinal, share_of_voice, competitor_set jsonb, citation_domains jsonb
```

`ai_scan_cells` is a materialized rollup written by the aggregator, so the dashboard never scans `ai_scan_runs`. RLS mirrors `scans` and `scan_points` (client_id join through `ai_scans`). Regenerate `lib/supabase/types.ts` rather than hand-writing the row types.

### 5.2 Metrics

`lib/metrics/` is the right home and nothing there conflicts. `turfReach` is already "% of cells where present", so `mentionRate` is the same shape over a different predicate. New pure files: `mentionRate.ts`, `shareOfVoice.ts`, `citationDomains.ts`, plus a `wilsonInterval.ts` so the UI can show a confidence band at k=5 instead of a false-precision percentage. `momentum.ts` works unchanged on any integer score.

### 5.3 Renderer

`components/turfmap/HeatmapGrid.tsx` needs one generalization, about half a day:

- `HeatmapCell` is `{ x, y, rank: number | null }` and `rankColor` maps four categorical values (lime / yellow / orange / red). A 0-100% metric needs a continuous ramp. Add a `mode: 'rank' | 'percent'` prop (default `'rank'` so every existing caller is untouched), a `value` field on the cell, and a percent color function that interpolates red → orange → yellow → lime.
- `rankLabel` prints the rank digit. Percent mode prints `82%` or a dash for zero runs.
- `GRID_SIZE = 9` and `CELL_PIXELS = 60` are module constants. `distFromCenter`, `MAX_DIST`, and cell placement all read them. Parameterize `gridSize` (cell pixels become `540 / gridSize`) so a 5×5 AI grid renders in the same 540px canvas with the same reveal animation. `lib/dataforseo/grid.ts` already accepts any odd `gridSize`, so coordinate generation needs no change.
- The legend and the "Not in 3-pack" copy live in the dashboard page, not the component, and get a percent variant.
- `HeatmapWithToggle` types competitor cells as `HeatmapCell[]`; it inherits the generalization for free and gives us the "compare to competitor" view on the AI heat map at no extra cost.

The CLAUDE.md rule that the 81-point grid is fixed applies to the Google scan and stays true. The AI grid is a separate, coarser grid by design (§3 explains why).

### 5.4 Runtime

This is the one real architectural constraint. `/api/scans/trigger` and the weekly cron both run inside a 300 s Vercel function, and the Google scan fits because 81 calls at concurrency 10 finish in about 40 s. An AI scan is hundreds of calls at 5 to 20 s each. It cannot run request-scoped.

Use the async pattern the repo already has for citations (`/api/cron/poll-citations`): a trigger inserts the `ai_scans` row and enqueues runs, a cron worker drains the queue in bounded batches, and the aggregator fires when `failed_runs + completed_runs = total_runs`. Where DFS offers `task_post` / `task_get` for an engine, use it (cheaper and DFS holds the queue). Where only Live exists, the worker calls Live under a concurrency cap and a per-minute budget guard.

---

## 6. Effort

| Phase | Scope | Estimate |
|---|---|---|
| Phase 0 | Run `scripts/ai-visibility-spike.ts` (in this branch) for one vertical, one city; label 150 answers; read the three answers in §7 | 2 operator days, under $10 of API spend even with a second run at k=10 |
| Phase 1 MVP | Migration + types (2 d), DFS adapters behind `lib/dataforseo/client.ts` + queue worker (5 d), extraction + labelled-set verify script (4 d), aggregator + metrics + intervals (2 d), renderer generalization + dashboard panel + citation domain list (4 d), cost tracking + manual setup + QA (3 d) | 20 focused dev days, 3 to 4 calendar weeks |
| Phase 2 | Remaining engines, scheduled refresh, trends, PDF section, share-of-voice UI | 2 to 3 weeks, after Phase 1 has two months of data |

Phase 1 assumes Phase 0 passes and the product shape in §3 is accepted. If Phase 0 shows no cell-level variance for the LLM engines, Phase 1 shrinks by about a week: drop the grid for those engines and ship a city-level mention rate plus citation mining.

---

## 7. Phase 0: what the spike must answer, and the kill criteria

The script in `scripts/ai-visibility-spike.ts` (`npm run spike:ai-visibility -- --dry-run` to try it) runs a configurable matrix (engines × grid × prompts × reps), writes one CSV row per run plus a per-cell rollup, and prints a cost line from the provider-reported costs, not from a price sheet. It has a `--dry-run` mode that exercises the whole pipeline with a fake engine so the matrix and the cost projection can be checked for free before any spend.

Recommended first run (about 150 grounded calls per engine):

| Setting | Value | Why |
|---|---|---|
| Vertical, city | plumbing, Toronto | Most scan history in the DB, so the Google competitor universe is already known |
| Grid | 3×3 at the client's service radius | Nine cells is enough to detect between-cell variance, and it spreads the neighbourhood labels far enough apart to be distinct |
| Prompts | 3 (recommendation, emergency, best-rated) | Same three the product would ship |
| Reps | 5 | The memo's k; the script reports what k=10 would have shown |
| Engines | AI Mode (coordinates), ChatGPT scraper (city + neighbourhood string), Perplexity via DFS (country + neighbourhood string) | One engine per location-targeting class, so the answer to Question 1 is per class |
| Spend | about $2 for the engine calls at Live prices, about $0.65 more with batched extraction; roughly $5.50 at k=10 (`--estimate` prints this) | Cheap enough to run several times |

Add the ChatGPT API route as a fourth engine only if the scraper's answers look unlike the consumer product (the scraper is the source we would ship, so it is the one that matters).

**Question 1: Does mention rate vary across cells more than it varies across repetitions?**
Compute, per engine, the between-cell variance of `mention_rate` against the within-cell binomial variance at the observed n (the three prompts are pooled per cell, so n = 15 at k=5; `runs.csv` has the per-prompt breakdown if one prompt behaves differently). The script prints both. Pass: between-cell variance is at least twice the within-cell variance for at least one engine. Fail: it is not, for every engine, in which case the geo-grid premise fails for LLM engines and we keep only the Google surfaces on a grid.

**Question 2: What is real cost per scan?**
Sum provider-reported cost per run. The script prints it per engine and extrapolates to 9 / 25 / 49 cells. This replaces the estimates in §3 with measured numbers.

**Question 3: How noisy is k=5?**
The script prints the width of the 95% Wilson interval at the observed k. At k=5 a 60% mention rate has an interval of roughly 23% to 88%. If the between-cell spread found in Question 1 is narrower than that, k=5 cannot see it and we either move to k=10 (doubling cost) or drop to a coarser grid with more reps per cell at the same budget. The decision rule is in the script output.

Do not skip the hand-labelling. The three answers above are only as good as the mention detector, and the memo is right that a labelled set has to exist before anyone trusts a dashboard number.

---

## 8. Things the UI and sales copy must say

- "Mention rate" is a sampled frequency with a confidence band, not a rank. Show the band.
- Location targeting differs by engine and the UI says which kind each engine uses (§2). Never imply a ChatGPT cell means "a user standing here".
- No placement guarantees. Directional intelligence, consistent with how the AI Coach already frames itself.
- Every trend line carries model version markers so a provider change is visible as such.
