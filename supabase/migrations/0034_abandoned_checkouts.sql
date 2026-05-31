-- 0034_abandoned_checkouts.sql
--
-- Cart-abandonment recovery for the scan-intake (/scan, /yourmap,
-- /fourdots, /freescan → /intake) funnel.
--
-- Background: a buyer who reaches Stripe Checkout but never pays leaves
-- an "Incomplete" PaymentIntent and an unpaid Checkout session. We now
-- shorten that session's lifetime to 60 minutes (see
-- /api/scan/checkout/init) so Stripe fires `checkout.session.expired`
-- ~1h after they bail. The webhook handler (handleAbandonedCheckout)
-- sends a 3-touch recovery sequence — touch 1 immediately, touches 2 & 3
-- queued via Resend scheduled-send at +24h / +72h (same mechanism as the
-- audit-call reminder; no sub-daily Vercel Cron, which Hobby tier can't
-- run).
--
-- This table exists for two reasons:
--
--   1. Idempotency. Stripe delivers webhooks at-least-once;
--      `checkout.session.expired` can arrive more than once for the same
--      session. A UNIQUE constraint on stripe_session_id + an
--      insert-on-conflict-do-nothing gate guarantees we send the
--      sequence exactly once per abandoned session.
--
--   2. Cancel-on-recovery. If the buyer comes back and completes a NEW
--      checkout (they can't resume the expired one — Stripe sessions are
--      single-use), /api/orders/fulfill cancels any still-pending
--      scheduled touches for that email so a recovered buyer is never
--      nagged. We store the Resend scheduled-email IDs to cancel them.
--
-- A recovered/converted buyer never receives a recovery email because
-- `checkout.session.expired` and `checkout.session.completed` are
-- mutually exclusive for a given session — the sequence only ever starts
-- for sessions that genuinely expired unpaid.

create table if not exists public.abandoned_checkouts (
  id uuid primary key default gen_random_uuid(),

  -- The expired Stripe Checkout session. UNIQUE so webhook retries
  -- converge to a single recovery sequence.
  stripe_session_id text not null unique,

  -- Buyer contact + the intake context we stamped on session metadata,
  -- copied here so the recovery emails + the prefilled resume link don't
  -- have to re-query Stripe.
  email text not null,
  business_name text,
  keyword text,
  tier text not null default 'scan',

  -- Resend email IDs for the +24h and +72h scheduled touches. Stored so
  -- /api/orders/fulfill can cancel them when the buyer recovers. NULL
  -- when the schedule call failed (touch 1 still sent) or RESEND_API_KEY
  -- wasn't set in the environment.
  touch_2_email_id text,
  touch_3_email_id text,

  -- Set when the buyer later completes a purchase (recovered) OR when an
  -- operator manually resolves the row. Non-null = sequence is done;
  -- fulfill skips already-recovered rows.
  recovered_at timestamptz,

  created_at timestamptz not null default now()
);

-- Recovery lookups in /api/orders/fulfill are keyed by buyer email,
-- filtered to still-pending (not yet recovered) rows. Partial index
-- keeps it small — recovered rows drop out of the working set.
create index if not exists abandoned_checkouts_email_pending_idx
  on public.abandoned_checkouts (email)
  where recovered_at is null;

comment on table public.abandoned_checkouts is
  'Scan-funnel cart-abandonment recovery. One row per expired unpaid Stripe Checkout session; drives the 3-touch recovery email sequence. See migration 0034.';
