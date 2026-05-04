-- Self-serve buyer support — billing-mode + Stripe identifiers + lead-orders.
--
-- Until now, every `clients` row was created by agency staff. With the
-- public marketing tripwire (turfmap.ai), self-serve buyers can pay via
-- Stripe Checkout and become their own clients without operator
-- intervention. This migration adds the schema needed to distinguish
-- those buyers from agency-managed clients and to track the Stripe
-- payment + subscription state that drives scheduled-scan eligibility.
--
-- 1. clients.billing_mode  — three-state enum:
--    'agency_managed'        : existing pattern. Agency invoices the
--                              client elsewhere, no Stripe relationship,
--                              cron fires scans freely on schedule.
--    'one_time'              : self-serve buyer who paid for a TurfScan
--                              ($99) / Visibility Audit ($499) /
--                              Strategy Session ($1,497). No recurring
--                              billing. Bundled re-scans (30/60/90-day)
--                              run via separate logic, not the weekly
--                              cron.
--    'self_serve_subscription' : self-serve buyer on TurfMap Pulse
--                                ($39/mo) or Pulse+ ($89/mo). Cron
--                                checks subscription_status='active'
--                                before firing. Stripe webhook keeps
--                                the status synced.
--
--    Default is 'agency_managed' so the column is safe to add — every
--    existing row keeps behaving the way it does today.
--
-- 2. clients.stripe_customer_id   — Stripe Customer object id, set
--                                    on first Checkout session for
--                                    this client. Populated by the
--                                    fulfill pipeline + webhook.
--    clients.stripe_subscription_id  — only set when billing_mode is
--                                    'self_serve_subscription'.
--    clients.subscription_status     — mirrored from Stripe webhook
--                                    events. Constrained to the set
--                                    of statuses the dashboard or
--                                    cron actually reads.
--
-- 3. lead_orders                  — one row per Stripe Checkout
--                                    session. Created on the
--                                    /order/success page load (server
--                                    component) using
--                                    INSERT ... ON CONFLICT DO NOTHING
--                                    so every refresh is idempotent.
--                                    The /api/orders/fulfill route
--                                    flips status to 'fulfilled' once
--                                    the client row + scan are
--                                    created. Useful for:
--                                      - audit ("who paid but didn't
--                                        complete the form?")
--                                      - recovery (if fulfill is
--                                        offline, the row preserves
--                                        the order for manual
--                                        completion)
--                                      - idempotency (prevent double-
--                                        fulfillment if buyer hits
--                                        submit twice)
--
-- Apply via the Supabase SQL editor. Safe to re-run (uses
-- IF NOT EXISTS / IF EXISTS guards throughout).

-- ─── 1. clients.billing_mode + Stripe identifiers ─────────────────────────

alter table clients
  add column if not exists billing_mode text not null default 'agency_managed';

-- Constrain the set of allowed values. Wrapped in DO block so re-runs
-- don't error when the constraint already exists (Postgres lacks
-- IF NOT EXISTS for CHECK constraints prior to v18).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_billing_mode_check'
  ) then
    alter table clients
      add constraint clients_billing_mode_check
      check (billing_mode in ('agency_managed', 'one_time', 'self_serve_subscription'));
  end if;
end$$;

alter table clients
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text;

-- Subscription status is a closed set drawn from Stripe's docs.
-- Storing as text + check constraint (rather than enum) so we can
-- adjust without a separate ALTER TYPE migration. Allowing NULL for
-- non-subscription billing modes.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_subscription_status_check'
  ) then
    alter table clients
      add constraint clients_subscription_status_check
      check (
        subscription_status is null
        or subscription_status in (
          'trialing',
          'active',
          'past_due',
          'canceled',
          'unpaid',
          'incomplete',
          'incomplete_expired',
          'paused'
        )
      );
  end if;
end$$;

-- Index for the cron's billing-mode filter — every cron tick looks up
-- "active subscriptions due for scan", which is a billing_mode +
-- subscription_status compound predicate.
create index if not exists clients_billing_mode_subscription_status_idx
  on clients (billing_mode, subscription_status)
  where billing_mode <> 'agency_managed';

-- Lookup index for the Stripe webhook (which arrives with subscription
-- ids and needs to find the right client row).
create index if not exists clients_stripe_subscription_id_idx
  on clients (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Same for customer id — the checkout-session-completed webhook uses
-- it to associate the session with a client.
create index if not exists clients_stripe_customer_id_idx
  on clients (stripe_customer_id)
  where stripe_customer_id is not null;


-- ─── 2. lead_orders table ─────────────────────────────────────────────────

create table if not exists lead_orders (
  id uuid primary key default gen_random_uuid(),

  -- Stripe Checkout session id ('cs_test_...' or 'cs_live_...'). Unique
  -- so we can use ON CONFLICT for idempotent upserts on /order/success
  -- page load.
  stripe_session_id text not null unique,

  -- The product tier the buyer purchased. Free text constrained by
  -- check below — keeps the migration simple while letting us add
  -- new tiers (or rename) without a column-type change.
  tier text not null,

  -- Captured from the Stripe session at order-success time. Pre-fills
  -- the form. Stored even if the buyer abandons before submitting so
  -- we can recover.
  email text,

  -- Set once the fulfill pipeline successfully creates the clients
  -- row + fires the scan. NULL means the order paid but never
  -- completed the form / scan trigger.
  client_id uuid references clients(id) on delete set null,

  -- Lifecycle: 'pending' on create, 'fulfilled' once /api/orders/fulfill
  -- completes successfully, 'failed' if fulfillment threw and we want
  -- to surface it for manual recovery.
  status text not null default 'pending',

  -- Stripe-side metadata we want quick access to without re-querying
  -- their API. JSON for flexibility — likely contains
  -- { stripe_customer_id, payment_status, amount_total }.
  stripe_metadata jsonb,

  -- Free-text scratch space for operator notes during manual recovery.
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lead_orders_status_check'
  ) then
    alter table lead_orders
      add constraint lead_orders_status_check
      check (status in ('pending', 'fulfilled', 'failed'));
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lead_orders_tier_check'
  ) then
    alter table lead_orders
      add constraint lead_orders_tier_check
      check (tier in ('scan', 'audit', 'strategy', 'pulse', 'pulse_plus'));
  end if;
end$$;

-- Recent-orders dashboards / "pending fulfillment" queue both want to
-- list-by-status filtered by recency.
create index if not exists lead_orders_status_created_at_idx
  on lead_orders (status, created_at desc);

-- The webhook + the order-success page load both look up by
-- stripe_session_id — UNIQUE constraint already provides the index,
-- but naming it explicit for clarity.
-- (no extra index needed)

-- updated_at auto-bump trigger so we don't have to remember to set
-- the column on every UPDATE. Pattern matches what other tables in
-- this schema already do.
create or replace function lead_orders_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists lead_orders_set_updated_at_trigger on lead_orders;
create trigger lead_orders_set_updated_at_trigger
  before update on lead_orders
  for each row
  execute function lead_orders_set_updated_at();

-- Row-level security: lead_orders contains buyer email + Stripe
-- session ids before a clients row exists. Service-role client (used
-- by /order/success and /api/orders/fulfill) bypasses RLS naturally;
-- we explicitly deny anonymous access so RLS is on by default.
alter table lead_orders enable row level security;

-- Agency staff (the `users` table) can read all lead_orders — useful
-- for the "pending fulfillment" support queue. Selectivity here is
-- low-volume so a simple email-membership check works.
drop policy if exists lead_orders_agency_read on lead_orders;
create policy lead_orders_agency_read on lead_orders
  for select
  using (
    exists (
      select 1 from users
      where users.email = current_setting('request.jwt.claim.email', true)
    )
  );

-- No insert/update/delete via PostgREST/RLS — those flow only through
-- the server-side route handlers using the service role.
