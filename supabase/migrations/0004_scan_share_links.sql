-- Public share links for scans. Used to send a single-scan dashboard
-- view to a prospect / stakeholder via URL — no signup, time-bounded,
-- revocable, with view-count tracking for sales signal.
--
-- Apply via the Supabase SQL editor (this project isn't connected
-- to MCP). Safe to re-run — every operation guarded with IF EXISTS.

create table if not exists scan_share_links (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  view_count integer default 0,
  last_viewed_at timestamptz,
  -- Per-share customization. NULL → use sensible TurfMap defaults.
  agency_label text,
  cta_text text,
  cta_url text
);

create index if not exists scan_share_links_scan_id_idx
  on scan_share_links (scan_id);

-- "Live" links = unexpired + not revoked. Used by the lookup endpoint.
create index if not exists scan_share_links_live_idx
  on scan_share_links (expires_at)
  where revoked_at is null;

alter table scan_share_links enable row level security;

comment on table scan_share_links is
  'Public share links for individual scans. Read access via /share/<id>.';
comment on column scan_share_links.id is
  'The token. UUID is unguessable enough for a 30-day window.';
comment on column scan_share_links.expires_at is
  'After this timestamp, the public share view returns 410 Gone.';
comment on column scan_share_links.revoked_at is
  'Set by the agency to kill a link before its expiry. Independent of expires_at.';
comment on column scan_share_links.view_count is
  'Incremented on every server-render of /share/<id>. Sales-funnel signal.';
