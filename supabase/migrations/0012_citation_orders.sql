-- 0012_citation_orders.sql
--
-- Citation Builder integration (BrightLocal). Tracks one row per
-- (client, location, BL order) tuple, plus per-directory status as
-- JSONB. The pattern mirrors `nap_audits` (which is read-side
-- BrightLocal): one parent row carries the order metadata, a JSONB
-- column carries the per-directory results.
--
-- Lifecycle:
--   1. Operator (or self-serve Pulse+ buyer) completes the richer
--      onboarding profile (categories, hours, photos, descriptions).
--   2. POST /api/citations/build → row inserted with status='queued',
--      brightlocal_order_id stamped from the BL response.
--   3. Cron /api/cron/poll-citations runs every 6 hours, polls BL
--      for each open order, updates per_directory + status.
--   4. status transitions queued → in_progress → complete (or
--      partial / failed). maintenance_paused goes true when the
--      client downgrades from pulse_plus and stops paying for
--      ongoing sync.
--
-- The BL Citation Builder API surface itself isn't shaped here —
-- this schema is intentionally generic enough to map any vendor's
-- per-directory submission flow. If we ever swap to Yext / Synup,
-- only lib/brightlocal/citationBuilder.ts changes.

create table if not exists citation_orders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  location_id uuid not null references client_locations(id) on delete cascade,

  -- Vendor reference. BrightLocal's order id (or whatever vendor we
  -- use). Unique because a single physical citation order shouldn't
  -- correspond to two TurfMap rows.
  brightlocal_order_id text unique,

  -- Lifecycle state, mirrored from BL polling.
  --   queued      — created locally; BL submit not yet acknowledged
  --   in_progress — BL accepted; submissions in flight to directories
  --   complete    — all directories returned terminal status
  --   partial     — some directories failed (needs operator attention)
  --   failed      — order itself failed at BL (rare; usually a NAP
  --                 validation error caught at submit time)
  status text not null default 'queued'
    check (status in ('queued', 'in_progress', 'complete', 'partial', 'failed')),

  -- Per-directory status, vendor-shaped JSONB. Expected shape:
  --   [{
  --      directory: 'bing' | 'yelp' | ... ,
  --      status: 'pending' | 'submitted' | 'live' | 'needs_review' | 'failed',
  --      submitted_at: iso8601 | null,
  --      live_at: iso8601 | null,
  --      url: string | null,
  --      message: string | null  -- needs-review reason (e.g. "owner verification required")
  --   }, ...]
  -- Polling cron rewrites this whole array on each refresh.
  per_directory jsonb not null default '[]'::jsonb,

  -- Cost tracking. Denominated in cents like dfs_cost_cents.
  --   wholesale_cents — what BL charged us
  --   billed_cents    — what we charged the buyer (for over-cap NAP
  --                     re-syncs; null on the initial build, which is
  --                     bundled into Pulse+ subscription cost)
  wholesale_cents integer,
  billed_cents integer,

  -- Maintenance gate. true means "stop syncing this listing." Flipped
  -- when the client downgrades from Pulse+ to Pulse (or churns), so
  -- BL stops being charged for ongoing sync. Existing live citations
  -- stay live; we just don't update them anymore.
  maintenance_paused boolean not null default false,

  -- Onboarding-form snapshot. Stored at submit time so a NAP edit on
  -- the client row doesn't retroactively change what we submitted to
  -- BL. Used by the dashboard's "submitted profile" preview + by the
  -- re-sync gate to compute which fields actually changed.
  submitted_profile jsonb,

  -- Free-text from BL on order-level errors. Most failures are
  -- per-directory and live in per_directory[].message.
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One open (non-paused, non-failed) citation order per location.
  -- Multiple completed historical orders are fine — those are
  -- audit-trail rows. The partial unique enforces "no duplicate
  -- live orders" without blocking re-orders after a churn cycle.
  constraint citation_orders_one_open_per_location
    exclude using btree (location_id with =)
    where (maintenance_paused = false and status not in ('failed'))
);

create index if not exists idx_citation_orders_client_id
  on citation_orders(client_id);
create index if not exists idx_citation_orders_status
  on citation_orders(status)
  where status in ('queued', 'in_progress');

-- ─── Per-location re-sync quota counter (for §6) ──────────────────────────
-- Tracks free-tier NAP re-syncs per location per quarter. The 0011-style
-- quarterly reset is handled by a cron that flips counters to 0 at the
-- start of each quarter, NOT by this schema.
--
-- Lives on client_locations rather than citation_orders because the
-- quota is per physical storefront (one location can have a lifecycle
-- of multiple BL orders if the operator churns + re-subscribes).
alter table client_locations
  add column if not exists citation_resync_count integer not null default 0;
alter table client_locations
  add column if not exists citation_resync_quota_resets_at timestamptz;

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Match the v1 posture from schema.sql: enable RLS, install no policies.
-- All access goes through the service-role client. Phase 3 portal work
-- will add policies that let portal users read citation_orders for
-- their own client_id.
alter table citation_orders enable row level security;
