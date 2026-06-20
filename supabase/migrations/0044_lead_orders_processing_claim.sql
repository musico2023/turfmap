-- 0044_lead_orders_processing_claim.sql
--
-- Atomic fulfillment claim for lead_orders (code-review finding #3).
--
-- /api/orders/fulfill previously did read-status → run side-effects →
-- mark fulfilled. Two concurrent /order/success loads both observed
-- 'pending' and both ran the full path → duplicate clients, scans,
-- emails, and external API spend.
--
-- Fix: a single atomic UPDATE claims the order before any side effect.
-- Only the request whose UPDATE returns a row proceeds; the loser gets
-- an idempotent "already processing / fulfilled" response.
--
--   1. Add a 'processing' state (the in-flight claim) to the status
--      CHECK constraint.
--   2. claim_lead_order_for_fulfillment(session_id): flips
--      pending|failed → processing in ONE statement (atomic at the row
--      level under READ COMMITTED), returning the claimed row or NULL.
--      Also re-claims a STALE 'processing' row (>15 min) so a crashed
--      fulfillment self-heals instead of stranding forever. The route's
--      maxDuration is 300s, so 15 min leaves a wide safety margin below
--      which a legitimately in-flight order is never re-claimed.
--
-- updated_at is bumped automatically by the existing
-- lead_orders_set_updated_at_trigger (migration 0008), so the staleness
-- window is measured from the moment of the claim.

alter table public.lead_orders
  drop constraint if exists lead_orders_status_check;

alter table public.lead_orders
  add constraint lead_orders_status_check
  check (status in ('pending', 'processing', 'fulfilled', 'failed'));

create or replace function public.claim_lead_order_for_fulfillment(
  p_session_id text
)
returns public.lead_orders
language sql
-- Pinned empty search_path per the 0035 security hardening — all
-- object references below are schema-qualified.
set search_path = ''
as $$
  update public.lead_orders
  set status = 'processing'
  where stripe_session_id = p_session_id
    and (
      status in ('pending', 'failed')
      or (status = 'processing' and updated_at < now() - interval '15 minutes')
    )
  returning *;
$$;

comment on function public.claim_lead_order_for_fulfillment(text) is
  'Atomically claim a lead_orders row for fulfillment: pending|failed -> '
  'processing (also re-claims processing rows stale >15min). Returns the '
  'claimed row, or NULL when another request already holds it or it is '
  'already fulfilled. See /api/orders/fulfill.';
