-- 0049_citation_orders_ghl_listings.sql
--
-- Citations vendor pivot: BrightLocal → GoHighLevel Listings (Uberall
-- engine).
--
-- Why: BL's plan caps "active locations" at 1, which walls off the whole
-- Pulse+ citations feature past the first client, and a plan bump isn't
-- economical. GHL Listings has no location cap ($30/mo wholesale per
-- sub-account, resellable) and we already run GHL. See
-- docs/TURFMAP_FOR_OUTREACH.md build log 2026-07-11.
--
-- Model change: BL was a one-time citation BUILD (create → confirm/pay →
-- poll per-directory statuses). GHL Listings is an ongoing SYNC — we
-- provision a GHL sub-account carrying the business profile, the operator
-- flips Listings ON for it (no public API for that toggle), and the
-- listings network keeps 70+ directories in sync while the subscription
-- runs. Two new lifecycle statuses:
--
--   awaiting_activation → sub-account provisioned (or queued for manual
--                         creation when the GHL plan gates the API);
--                         operator hasn't toggled Listings ON yet
--   active              → operator confirmed activation; sync running
--
-- provider discriminates rows so the dashboard renders the right panel
-- and the BL poll cron skips GHL rows (nothing to poll — no per-directory
-- status feed on the public API). Existing rows backfill 'brightlocal'.

alter table public.citation_orders
  add column if not exists provider text not null default 'brightlocal';

alter table public.citation_orders
  drop constraint if exists citation_orders_provider_check;

alter table public.citation_orders
  add constraint citation_orders_provider_check
  check (provider in ('brightlocal', 'ghl_listings'));

-- GHL sub-account id (their "location id"), stamped when API provisioning
-- succeeds. Null while a plan-gated order waits for manual creation.
alter table public.citation_orders
  add column if not exists ghl_location_id text;

alter table public.citation_orders
  drop constraint if exists citation_orders_status_check;

alter table public.citation_orders
  add constraint citation_orders_status_check
  check (status in (
    'awaiting_confirm', 'awaiting_activation', 'active',
    'queued', 'in_progress', 'complete', 'partial', 'failed'
  ));

-- Note: citation_orders_one_open_per_location (0012) excludes only
-- status='failed' from openness, so awaiting_activation/active rows
-- correctly block a duplicate order for the same location.
