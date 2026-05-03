-- Short, random public identifier for clients.
--
-- Until now, every URL / API path / share link / dashboard link used
-- the client's full UUID (`/clients/00000000-0000-4000-a000-...`).
-- That's:
--   1. Long. 36 characters in every URL, every PDF filename, every
--      Slack message you paste a link into.
--   2. Sequential when seeded with synthetic test UUIDs (the kidcrew
--      row's `...000000000003` literally telegraphs "this is the
--      third client") — which leaks information about the agency's
--      client count + onboarding order to anyone who sees a URL.
--
-- This migration adds `clients.public_id`: a 10-character lowercase
-- alphanumeric (base16 hex from a fresh random source). Auto-generated
-- on insert via column DEFAULT, backfilled for existing rows, with a
-- unique index for fast lookups + collision protection. The internal
-- `id` UUID is unchanged — every foreign key still works — but every
-- user-facing surface (URLs, share links, dashboards) now uses
-- public_id instead.
--
-- Collision math: 16^10 = 1.1 trillion combinations. At the agency
-- scale TurfMap operates at (hundreds of clients), the unique index
-- catches any collision and the insert retries naturally via app
-- code. We're nowhere near the birthday-paradox break-even (~1M).
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table clients
  add column if not exists public_id text;

-- Backfill: every existing client row gets a fresh random public_id.
-- Using md5 of (random + uuid + clock) gives us a hex string that's
-- both random and uniquely seeded per row.
update clients
set public_id = substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 10)
where public_id is null;

-- Make non-null + unique going forward.
alter table clients
  alter column public_id set not null;

create unique index if not exists clients_public_id_idx
  on clients (public_id);

-- New rows get an auto-generated public_id. Same recipe as the
-- backfill so behavior is consistent.
alter table clients
  alter column public_id set default substr(
    md5(random()::text || gen_random_uuid()::text || clock_timestamp()::text),
    1,
    10
  );

comment on column clients.public_id is
  'Short (10-char) random user-facing identifier. URLs and dashboard links use this instead of the UUID id. Auto-generated on insert; UUID id remains the primary key + foreign-key target.';
