-- NAP audit history. One row per BrightLocal Listings audit run for a
-- client. Operator-only (no client-portal surface in v1) — feeds the
-- AI Coach prompt with grounded citation data so insights cite real
-- structural problems instead of guessing at "review counts" etc.
--
-- Also adds structured NAP columns to clients (phone + city/region/
-- postcode/street_address). BrightLocal's Listings API requires those
-- fields broken out, not as a single address string. Bundled here
-- since the audit endpoint can't function without them.
--
-- Apply via the Supabase SQL editor. Safe to re-run.
--
-- Rate-limit policy: at most 4 audits per client per 30 days.
-- Enforced at the API route level by counting recent rows on insert.

-- ─── Structured NAP columns on clients ──────────────────────────────────
-- BrightLocal's Find Profile endpoint takes business_name + telephone +
-- street_address + city + region + postcode + country (ISO-3166-1
-- alpha-3) as separate fields. We keep the existing `address` column
-- for human display; structured columns are additive.
alter table clients add column if not exists phone text;
alter table clients add column if not exists street_address text;
alter table clients add column if not exists city text;
alter table clients add column if not exists region text;
alter table clients add column if not exists postcode text;
alter table clients add column if not exists country_code text default 'USA';

comment on column clients.phone is
  'Canonical phone for NAP citation matching. E.164 preferred (e.g. +1-416-555-0100).';
comment on column clients.street_address is
  'Street address only (no city/state/zip) — required by BrightLocal Listings API.';
comment on column clients.city is
  'City — required by BrightLocal Listings API.';
comment on column clients.region is
  'State/province — required by BrightLocal Listings API.';
comment on column clients.postcode is
  'Postal/ZIP code — required by BrightLocal Listings API.';
comment on column clients.country_code is
  'ISO-3166-1 alpha-3 country code (e.g. USA, GBR, CAN). Default USA.';

-- ─── nap_audits table ──────────────────────────────────────────────────
create table if not exists nap_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  triggered_by uuid references users(id) on delete set null,
  created_at timestamptz default now(),
  -- BrightLocal Listings is per-directory + async: we POST one Find
  -- Profile per directory, get a request_id back, then poll each
  -- request_id until ready. Status reflects the aggregate.
  status text not null default 'pending'
    check (status in ('pending', 'running', 'complete', 'failed')),
  -- Map of directory → BrightLocal request_id. JSON shape:
  --   [{ directory: 'google', request_id: '...' }, ...]
  -- Replaces the old singular brightlocal_report_id column — Citation
  -- Tracker (single report) doesn't exist in the public Data APIs;
  -- you fan out across directories yourself.
  brightlocal_requests jsonb,
  -- Directories BrightLocal rejected at initiate time (4xx). Useful
  -- for spotting bad slugs in the default directory list.
  brightlocal_rejected jsonb,
  -- Headline numbers for fast dashboard reads.
  total_citations integer,
  inconsistencies_count integer,
  missing_high_priority_count integer,
  -- Full structured findings, derived from the per-directory polls.
  -- JSON shape:
  --   {
  --     citations: [{ directory, url, name, address, phone, status }],
  --     inconsistencies: [{ field, canonical, found, citation_url, directory }],
  --     missing: [{ directory, priority }]
  --   }
  findings jsonb,
  -- Echo of the raw upstream Get Results responses (one per directory)
  -- in case we need to re-derive structured fields after a parser change.
  raw_response jsonb,
  completed_at timestamptz,
  error_message text
);

create index if not exists nap_audits_client_id_idx
  on nap_audits (client_id);
create index if not exists nap_audits_recent_idx
  on nap_audits (client_id, created_at desc);
create index if not exists nap_audits_status_idx
  on nap_audits (status)
  where status in ('pending', 'running');

alter table nap_audits enable row level security;

comment on table nap_audits is
  'Citation audit history per client. Source: BrightLocal Listings (Data APIs). Operator-only — surfaced in agency dashboard and fed into AI Coach prompt; not shown to portal users.';
comment on column nap_audits.findings is
  'Structured JSON: {citations, inconsistencies, missing}. Derived from raw_response; parser may evolve, so raw_response is preserved.';
comment on column nap_audits.brightlocal_requests is
  'Per-directory BrightLocal request_ids: [{directory, request_id}]. Used to poll for completion across the audit''s directory set.';
comment on column nap_audits.brightlocal_rejected is
  'Directories BL rejected at initiate (4xx): [{directory, error}]. For diagnosing bad slugs in the default directory list.';
