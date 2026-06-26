-- 0045_keyword_candidates.sql
--
-- v1 of the Competitor Keyword Reveal (the free-scan conversion mechanic).
-- Two additive tables — no existing schema touched.
--
-- keyword_candidates: the ranked keyword list surfaced on a free scan's
--   /share page. One row per candidate keyword for a given scan: the
--   service×intent candidates we generate (lib/keywords/suggestions.
--   rankLocalKeywordCandidates), each tagged with whether it triggers a
--   local pack (grid-eligibility gate) and whether a top local-pack
--   competitor ranks for it (the locked-row reveal hook). The scanned
--   keyword is status='tracked'; the rest render locked.
--
-- competitor_keyword_cache: caches the expensive DFS keywords_for_site
--   lookup by competitor domain (30–90d TTL applied in code) so repeat
--   scans — or different businesses sharing a competitor — don't re-pay.
--   This is the cost-control backstop: the suggester is cheap, the Labs +
--   local-pack calls are the spend, and they run once per unique domain.
--
-- RLS: enabled, NO policies — service-role-only, anon denied. Matches the
-- v1 posture used by the other typed tables (see 0041). The /share page
-- reads via the server (service role); nothing client-side touches these.

create table if not exists public.keyword_candidates (
  id uuid primary key default gen_random_uuid(),

  -- The scan whose competitor data produced this candidate. Cascade so a
  -- GC'd preview scan (30d cron) takes its candidates with it.
  scan_id uuid not null references public.scans(id) on delete cascade,

  -- The candidate keyword (display form, e.g. "roofer oshawa") + its
  -- geo-independent service stem.
  keyword text not null,
  stem text,

  -- Intent class (forward-compat with v1 competitor-mined keywords). MVP
  -- templated candidates are all 'service'.
  intent text not null default 'service'
    check (intent in ('service', 'commercial', 'informational')),

  -- Does the keyword trigger a local pack? NULL = not yet gated. FALSE =
  -- gated out (ranks the same everywhere — wrong for a geo-grid).
  local_pack_present boolean,

  -- Does a top local-pack competitor rank for it? The reveal's punchline.
  competitor_ranked boolean not null default false,
  -- Which competitor domain surfaced it (named in the reveal where shown).
  competitor_domain text,

  -- Internal Priority ordering — NOT TurfScore. Higher = better starter
  -- keyword. See lib/keywords/suggestions.rankLocalKeywordCandidates.
  priority numeric,

  -- Lifecycle. 'tracked' = the keyword we actually scanned; 'suggested' =
  -- a locked reveal row; 'excluded_no_localpack' = failed the gate.
  status text not null default 'suggested'
    check (status in ('suggested', 'selected', 'tracked', 'excluded_no_localpack')),

  created_at timestamptz default now(),

  -- One row per (scan, keyword) — re-running the builder upserts.
  unique (scan_id, keyword)
);

create index if not exists idx_keyword_candidates_scan
  on public.keyword_candidates(scan_id);

comment on table public.keyword_candidates is
  'Ranked keyword candidates for a free scan''s /share reveal. One row per '
  '(scan, keyword): service×intent candidates tagged with local-pack '
  'eligibility + competitor_ranked. status=tracked is the scanned keyword; '
  'suggested rows render locked. See lib/keywords/competitorReveal.ts.';

alter table public.keyword_candidates enable row level security;

create table if not exists public.competitor_keyword_cache (
  -- Competitor domain is the cache key (one DFS keywords_for_site result
  -- per domain, reused across scans).
  domain text primary key,

  -- Raw + filtered keywords-for-site payload (the ranking keywords we
  -- intersect against the local-intent set).
  payload jsonb not null,

  -- Which DFS endpoint produced it (e.g. 'labs/keywords_for_site').
  source_api text not null,

  -- Cost of the lookup, mirroring scans.dfs_cost_cents / gbp_signals.
  -- fetch_cost_cents — keeps unit economics visible from day one.
  fetch_cost_cents integer,

  fetched_at timestamptz not null default now()
);

comment on table public.competitor_keyword_cache is
  'Caches DFS keywords_for_site results by competitor domain (TTL applied '
  'in code, 30–90d) so repeat scans / shared competitors don''t re-pay. '
  'The cost-control backstop for the competitor keyword reveal.';

alter table public.competitor_keyword_cache enable row level security;
