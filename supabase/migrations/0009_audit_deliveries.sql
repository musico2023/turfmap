-- Strategist-managed audit-delivery workflow.
--
-- The Visibility Audit ($499) and Strategy Session ($1,497) tiers
-- promise human-authored deliverables on top of the auto-scan +
-- AI Coach output that every tier ships. Specifically:
--
--   - 30-min (Visibility Audit) / 60-min (Strategy Session) live call
--     with a TurfMap strategist
--   - Strategist-authored notes after the call
--   - For Strategy Session: 3 competitor GBP teardowns with annotated
--     screenshots + a comparative report covering the 3 keyword angles
--   - A customized branded PDF combining the auto-output + the
--     strategist's contributions, delivered post-call
--
-- This migration adds the columns the agency-side workflow needs to
-- track this lifecycle on the existing lead_orders rows. Phase 1
-- scope (this migration): notes + delivered PDF. Phase 2 (future)
-- adds call_scheduled_at / call_completed_at / competitor_screenshots /
-- comparative_report — those are deferred until the manual flow is
-- proven and can be polished.
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table lead_orders
  add column if not exists strategist_notes text,
  add column if not exists delivery_pdf_url text,
  add column if not exists delivered_at timestamptz;

-- Index for the agency-side "Audit deliveries" queue, which is sorted
-- by paid date with status filters. Covering the (delivered_at,
-- created_at) compound lets us efficiently filter "still in progress"
-- (delivered_at is null) and sort oldest-first.
create index if not exists lead_orders_audit_queue_idx
  on lead_orders (delivered_at, created_at desc)
  where tier in ('audit', 'strategy');
