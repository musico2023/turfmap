-- 0018_gbp_signals.sql
--
-- Adds Google Places (New) enrichment for client locations. The
-- AI Coach prompt can cite specific GBP signals when present
-- (rating, review count, primary category, hours) instead of
-- generic recommendations. See lib/anthropic/prompts/turfCoach.ts
-- for the consumer.
--
-- Schema:
--   client_locations.google_place_id — stable Google identifier,
--     looked up once at onboarding via Find Place from Text. Null
--     when the strict match guardrail (name + <100m) failed; we
--     prefer no signals over wrong-business signals.
--   gbp_signals — refreshed weekly via cron. Stores the snapshot
--     fields the AI Coach reads. One row per (client_location, fetch).
--     Latest-by-fetched_at wins; old rows kept for trend analysis.
--
-- TTL: Google's terms permit caching place_id forever and most
-- fields up to 30 days. Reviews text + photos require Enterprise
-- tier; we don't fetch those so the 30-day rule is moot.
--
-- Apply via the Supabase SQL editor. Safe to re-run.

-- ─── client_locations.google_place_id ───────────────────────────────────
alter table client_locations
  add column if not exists google_place_id text;

comment on column client_locations.google_place_id is
  'Stable Google Places (New) place_id for this location. Looked up once at onboarding via Find Place from Text with name + locationBias. Null when the strict match guardrail (name + <100m) failed — we never store an uncertain match. Place IDs cache forever per Google''s terms.';

create index if not exists client_locations_google_place_id_idx
  on client_locations (google_place_id);

-- ─── gbp_signals table ──────────────────────────────────────────────────
create table if not exists gbp_signals (
  id uuid primary key default gen_random_uuid(),
  client_location_id uuid not null references client_locations(id) on delete cascade,
  -- Snapshot fields from Place Details (Pro tier).
  rating numeric,                       -- 0-5, two decimals
  user_ratings_total integer,           -- review count
  primary_type text,                    -- Google's designated primary category
  types text[],                         -- all categories (incl. primary)
  business_status text,                 -- OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY
  phone_number text,
  website_uri text,
  photos_count integer,                 -- count only; we don't fetch photo URIs
  price_level text,                     -- PRICE_LEVEL_FREE..PRICE_LEVEL_VERY_EXPENSIVE
  editorial_summary text,               -- often null; helpful color when present
  -- Hours: store the structured weekly schedule as JSON. Renderers
  -- in the Coach prompt format it as a one-line summary.
  regular_opening_hours jsonb,
  -- Cost tracking — mirrors scans.dfs_cost_cents pattern.
  -- One Place Details Pro fetch ≈ $0.020 = 2 cents. Find Place
  -- onboarding lookup is tracked separately on the location row.
  fetch_cost_cents integer not null default 2,
  fetched_at timestamptz not null default now(),
  -- Raw response payload for debugging + future field extraction
  -- without re-fetching. Excludes review text + photo URIs (we don't
  -- fetch those tiers).
  raw jsonb
);

create index if not exists gbp_signals_client_location_idx
  on gbp_signals (client_location_id, fetched_at desc);

alter table gbp_signals enable row level security;

comment on table gbp_signals is
  'Google Places (New) Place Details snapshots per client_location. Refreshed weekly via cron/refresh-gbp-signals. AI Coach reads the latest row (fetched_at desc) when generating playbooks. Cost-tracked via fetch_cost_cents to mirror scans.dfs_cost_cents.';
comment on column gbp_signals.fetch_cost_cents is
  'Cost in cents for this fetch. Place Details Pro = 2¢ baseline; raise if upgrading to Enterprise tier later.';
comment on column gbp_signals.raw is
  'Raw Place Details response (Pro tier fields only). Useful for debugging match quality and extracting new fields without a re-fetch.';
