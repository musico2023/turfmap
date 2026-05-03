-- Multi-location support for TurfMap clients.
--
-- Until now, a clients row has been both the brand-level entity (name,
-- branding, billing, status) AND a single physical location (address,
-- coords, phone, scan radius). That breaks for clients with more than
-- one storefront — Kidcrew Medical for example has a Wychwood location
-- and a Don Mills location, each with its own NAP, GBP listing, scan
-- grid, and citation profile.
--
-- This migration:
--   1. Creates `client_locations` — one row per physical location, FK
--      to clients. Holds NAP + coords + service radius + GBP url.
--   2. Backfills one is_primary=true location per existing client by
--      copying its current location-shaped columns.
--   3. Adds `location_id` to scans / tracked_keywords / nap_audits /
--      competitors and backfills each row's location_id from its
--      client's primary location.
--   4. Leaves the legacy location columns on `clients` for backward-
--      compat — code paths read from client_locations going forward
--      and the old columns become deprecated mirrors. A follow-up
--      migration will drop them once we've verified nothing reads
--      them anymore.
--
-- Apply via the Supabase SQL editor. Safe to re-run.

-- ─── client_locations table ──────────────────────────────────────────────
create table if not exists client_locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  -- Operator-facing label, e.g. "Wychwood", "Don Mills", "Main Office".
  -- Surfaced in the dashboard's location switcher and in the AI Coach's
  -- cross-sibling reasoning ("Wychwood is dominant but Don Mills is
  -- invisible — here's why").
  label text,
  -- Exactly one primary per client (enforced by partial unique index
  -- below). Brand-level views default to the primary.
  is_primary boolean not null default false,
  -- Display address (freeform). Used for geocoding + human display.
  address text,
  -- Structured NAP fields — sent to BrightLocal Listings audits.
  street_address text,
  city text,
  region text,
  postcode text,
  country_code text default 'USA',
  phone text,
  -- Geocoded coords for the scan grid.
  latitude numeric,
  longitude numeric,
  -- Optional pin-only override for visualization (when the geocoded
  -- centroid doesn't quite match the storefront entrance).
  pin_lat numeric,
  pin_lng numeric,
  -- Half-width of the scan grid. Per-location since suburban + urban
  -- offices can have very different effective service radii.
  service_radius_miles numeric default 1.6,
  -- Optional Google Business Profile listing URL — useful operator
  -- info, may be plumbed into the audit pipeline later.
  gbp_url text,
  created_at timestamptz default now()
);

-- Exactly one primary location per client.
create unique index if not exists client_locations_one_primary_per_client
  on client_locations (client_id) where is_primary = true;

create index if not exists client_locations_client_id_idx
  on client_locations (client_id);

alter table client_locations enable row level security;

comment on table client_locations is
  'Per-location NAP + scan-grid data. A clients row is the brand entity; client_locations are its physical locations. Exactly one is_primary=true per client. Created in migration 0006.';
comment on column client_locations.label is
  'Operator-facing short name (e.g. "Wychwood"). Defaults to city if null.';
comment on column client_locations.is_primary is
  'Exactly one primary per client. The primary is what brand-level views default to and what existing pre-multi-location code paths fall back to.';
comment on column client_locations.gbp_url is
  'Optional Google Business Profile URL for this specific location.';

-- ─── Backfill: one primary location per existing client ─────────────────
-- Copy the legacy location columns off the clients row into a new
-- primary location. Skips clients that somehow already have a primary
-- (idempotent re-run).
insert into client_locations (
  client_id,
  is_primary,
  label,
  address,
  street_address,
  city,
  region,
  postcode,
  country_code,
  phone,
  latitude,
  longitude,
  pin_lat,
  pin_lng,
  service_radius_miles,
  created_at
)
select
  c.id,
  true,
  c.city,                       -- label defaults to city; operator can rename
  c.address,
  c.street_address,
  c.city,
  c.region,
  c.postcode,
  coalesce(c.country_code, 'USA'),
  c.phone,
  c.latitude,
  c.longitude,
  c.pin_lat,
  c.pin_lng,
  coalesce(c.service_radius_miles, 1.6),
  c.created_at
from clients c
where not exists (
  select 1 from client_locations l
  where l.client_id = c.id and l.is_primary = true
);

-- ─── location_id on dependent tables ────────────────────────────────────
-- Each scan / tracked keyword / NAP audit / competitor row belongs to
-- one location. Initially nullable so the migration is non-destructive;
-- backfilled below; new writes always set it via the application layer.
alter table scans add column if not exists location_id uuid
  references client_locations(id) on delete set null;
alter table tracked_keywords add column if not exists location_id uuid
  references client_locations(id) on delete set null;
alter table nap_audits add column if not exists location_id uuid
  references client_locations(id) on delete set null;
alter table competitors add column if not exists location_id uuid
  references client_locations(id) on delete set null;

-- Backfill: each existing dependent row inherits its client's primary
-- location.
update scans s
  set location_id = l.id
  from client_locations l
  where l.client_id = s.client_id
    and l.is_primary = true
    and s.location_id is null;

update tracked_keywords k
  set location_id = l.id
  from client_locations l
  where l.client_id = k.client_id
    and l.is_primary = true
    and k.location_id is null;

update nap_audits a
  set location_id = l.id
  from client_locations l
  where l.client_id = a.client_id
    and l.is_primary = true
    and a.location_id is null;

update competitors cp
  set location_id = l.id
  from client_locations l
  where l.client_id = cp.client_id
    and l.is_primary = true
    and cp.location_id is null;

create index if not exists scans_location_id_idx on scans (location_id);
create index if not exists tracked_keywords_location_id_idx on tracked_keywords (location_id);
create index if not exists nap_audits_location_id_idx on nap_audits (location_id);
create index if not exists competitors_location_id_idx on competitors (location_id);

-- Note on legacy columns:
-- We deliberately do NOT drop clients.address / .latitude / .longitude /
-- .pin_lat / .pin_lng / .service_radius_miles / .phone /
-- .street_address / .city / .region / .postcode / .country_code in this
-- migration. They become deprecated mirrors. A follow-up migration
-- (0007 or later) will drop them once we've verified every read site
-- has switched to client_locations.
