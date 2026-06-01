-- 0038_score_preview_throttle.sql
--
-- Per-email / per-IP throttle for the /score lead-magnet flow.
-- Without this, anyone can scrape 81-point scans for arbitrary
-- businesses by cycling email addresses.
--
-- Two unique constraints on (key, day) — one with key='email:<addr>',
-- one with key='ip:<addr>'. The preview-init route inserts both
-- rows in a transaction; either row's UNIQUE violation aborts the
-- scan with a 429.
--
-- Limits (in lib/score/throttle.ts at the call site, not enforced
-- at the DB layer):
--   1 preview per email per 24h
--   5 previews per IP per 24h
--
-- Day-bucketed via date_trunc('day', ...) so the limit resets at
-- UTC midnight. Not a sliding window — that's overkill for v1.
-- A determined attacker can wait until midnight; that's fine,
-- we don't need to stop targeted attacks, just casual scraping.
--
-- Rows are GC'd by the existing daily preview-client cleanup cron
-- (cron/gc-preview-clients) on a 7-day retention — keeps the table
-- small + lets us audit recent rate-limit hits when debugging.

create table public.score_preview_throttle (
  id uuid primary key default gen_random_uuid (),
  -- Format: 'email:foo@bar.com' or 'ip:1.2.3.4'. Prefix keeps the
  -- two key spaces from colliding.
  key text not null,
  -- UTC-truncated day for bucketing. UNIQUE on (key, day) so the
  -- second insert in a day returns 23505.
  day date not null default (current_date),
  share_id uuid references public.scan_share_links (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  created_at timestamptz not null default now (),
  -- Stamped with the scan result so we can debug whether the throttle
  -- hit was useful or a false positive. Cheap text, not a foreign key.
  business_name text,
  ip text,
  email text,
  unique (key, day)
);

create index score_preview_throttle_created_at_idx
  on public.score_preview_throttle (created_at desc);

alter table public.score_preview_throttle enable row level security;

comment on table public.score_preview_throttle is
  'Per-email + per-IP throttle log for the /score lead-magnet '
  'preview flow. Two rows per scan (one keyed by email, one by IP). '
  'UNIQUE (key, day) is what blocks repeat scans within a 24h UTC '
  'window. GC at 7 days by gc-preview-clients cron.';
