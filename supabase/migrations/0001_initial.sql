-- TurfMap.ai — Initial schema (Phase 1)
-- Multi-tenant geo-grid rank tracker. Agency owns infra, clients are tenants.
--
-- RLS posture in v1: enabled everywhere with client_id, NO policies installed yet.
-- That means no anon/authenticated role can read or write these tables.
-- All server-side code uses the service_role key (bypasses RLS).
-- Real policies will be added in Phase 3 when the client portal is built.

-- ─── extensions ────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ─── users (agency staff) ──────────────────────────────────────────────────
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  full_name text,
  role text check (role in ('admin', 'manager', 'analyst')) default 'analyst',
  created_at timestamptz default now()
);

-- ─── clients (the home services businesses being tracked) ──────────────────
create table clients (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  address text not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  pin_lat numeric(10, 7),
  pin_lng numeric(10, 7),
  service_radius_miles numeric default 1.6,
  industry text,
  primary_color text default '#c5ff3a',
  logo_url text,
  status text check (status in ('active', 'paused', 'churned')) default 'active',
  monthly_price_cents integer,
  stripe_customer_id text,
  onboarded_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ─── tracked_keywords ──────────────────────────────────────────────────────
create table tracked_keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  keyword text not null,
  is_primary boolean default false,
  scan_frequency text check (scan_frequency in ('daily', 'weekly', 'biweekly', 'monthly')) default 'weekly',
  created_at timestamptz default now(),
  unique(client_id, keyword)
);

create index idx_tracked_keywords_client_id on tracked_keywords(client_id);

-- ─── scans (one keyword scanned at one point in time) ──────────────────────
create table scans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  keyword_id uuid references tracked_keywords(id) on delete cascade,
  scan_type text check (scan_type in ('scheduled', 'on_demand')) not null,
  grid_size integer default 9,
  status text check (status in ('queued', 'running', 'complete', 'failed')) default 'queued',
  -- Computed metrics
  turf_score numeric,
  top3_win_rate numeric,
  turf_radius_units integer,
  total_points integer,
  failed_points integer default 0,
  -- DataForSEO cost tracking
  dfs_cost_cents integer,
  -- Timing
  started_at timestamptz default now(),
  completed_at timestamptz,
  created_at timestamptz default now()
);

create index idx_scans_client_completed on scans(client_id, completed_at desc);

-- ─── scan_points (each grid cell's result for a scan) ──────────────────────
create table scan_points (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete cascade,
  grid_x integer not null,
  grid_y integer not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  rank integer,
  business_found boolean default false,
  competitors jsonb,
  raw_response jsonb,
  created_at timestamptz default now()
);

create index idx_scan_points_scan_id on scan_points(scan_id);

-- ─── ai_insights ───────────────────────────────────────────────────────────
create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete cascade,
  diagnosis text,
  actions jsonb,
  projected_impact text,
  model text default 'claude-sonnet-4',
  prompt_version text,
  created_at timestamptz default now()
);

-- ─── competitors (aggregated from scan_points) ─────────────────────────────
create table competitors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  competitor_name text not null,
  google_place_id text,
  last_amr numeric,
  last_top3_pct numeric,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  unique(client_id, google_place_id)
);

-- ─── client_users (white-label portal accounts) ────────────────────────────
create table client_users (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  email text unique not null,
  invited_at timestamptz default now(),
  last_login_at timestamptz
);

-- ─── RLS (enabled, no policies yet — see header comment) ───────────────────
alter table users           enable row level security;
alter table clients         enable row level security;
alter table tracked_keywords enable row level security;
alter table scans           enable row level security;
alter table scan_points     enable row level security;
alter table ai_insights     enable row level security;
alter table competitors     enable row level security;
alter table client_users    enable row level security;
