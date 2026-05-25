-- 0031_coldscan_bypass.sql
--
-- Skip Stripe Checkout for the COLDSCAN cold-email cohort.
--
-- Today reply-driven cold-email prospects hit /yourmap?coupon=COLDSCAN,
-- click through Stripe Checkout for a $0 charge (100%-off coupon), then
-- /order/success creates the client + scan via the post-Stripe-webhook
-- /api/orders/fulfill path. Stripe is buying us conversion tracking and
-- friction; on a free scan it adds zero value.
--
-- New path: /yourmap renders a one-click "Run my free TurfScan" button
-- when coupon=COLDSCAN + valid prospect_id + the prospect has geo
-- backfilled. The button POSTs to /api/yourmap/coldscan-fulfill which
-- directly creates client + location + tracked_keyword + lead_order +
-- scan + share_link, then redirects the buyer to /share/[id].
--
-- Three schema changes here:
--
--   1. prospects.address / latitude / longitude — populated by the
--      lead-gen pipeline at row-build time (the CSV already carries
--      address + geo for every row). Nullable: legacy prospects don't
--      have these yet; the lander falls back to the Stripe checkout
--      path when geo is missing on a row.
--
--   2. lead_orders.stripe_session_id — relax NOT NULL so free coldscan
--      orders can record a row without a Stripe session. Cohort marker
--      lives in stripe_metadata->>'source' = 'coldscan_free' so the
--      no-Stripe rows are easy to filter for reporting + don't get
--      mistaken for Stripe-backed orders by downstream code.
--
--   3. lead_orders UNIQUE partial index on (source, prospect_id) — atomic
--      one-free-scan-per-prospect guarantee. Without it, two concurrent
--      POSTs from the same prospect_id could each pass the converted_at
--      check and both create a duplicate client + scan + order, burning
--      ~2x the DFS budget. The partial predicate keeps the index small
--      (only coldscan_free rows participate; Stripe-backed rows are
--      independent and don't compete for the constraint).

-- ─── 1. prospects: geo columns ─────────────────────────────────────
alter table public.prospects
  add column if not exists address text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

comment on column public.prospects.address is
  'Street address resolved by the lead-gen pipeline (Google Places match). '
  'NULL on legacy rows pre-2026-05-25 — /yourmap falls back to the Stripe '
  'checkout path when geo is missing.';
comment on column public.prospects.latitude is
  'Decimal latitude from the lead-gen pipeline geocoding. Used by the '
  'coldscan bypass to seed the 9x9 scan grid without a runtime geocode.';
comment on column public.prospects.longitude is
  'Decimal longitude from the lead-gen pipeline geocoding. Paired with '
  'latitude in the coldscan bypass.';

-- ─── 2. lead_orders: stripe_session_id nullable ────────────────────
alter table public.lead_orders
  alter column stripe_session_id drop not null;

comment on column public.lead_orders.stripe_session_id is
  'Stripe Checkout Session id. NULL for orders that bypassed Stripe '
  '(e.g. COLDSCAN free-scan path — see stripe_metadata->>''source'').';

-- ─── 3. Idempotency: one free coldscan per prospect ────────────────
-- Atomic unique constraint on prospect_id within the coldscan_free
-- source. Two concurrent POSTs from the same prospect_id resolve to
-- one row; the second insert fails on the constraint and the route
-- returns the existing share link.
create unique index if not exists lead_orders_coldscan_prospect_uidx
  on public.lead_orders ((stripe_metadata->>'prospect_id'))
  where (stripe_metadata->>'source') = 'coldscan_free';

-- ─── 4. Reporting: coldscan cohort lookup ──────────────────────────
-- Cheap btree on the source marker for cohort P&L / volume queries
-- ("how many coldscan_free conversions this week"). Partial predicate
-- keeps it tight.
create index if not exists lead_orders_coldscan_source_idx
  on public.lead_orders ((stripe_metadata->>'source'))
  where (stripe_metadata->>'source') = 'coldscan_free';
