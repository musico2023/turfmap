-- Audit upsell page-only enforcement.
--
-- Anthony policy 2026-06-13 ("option C"): the $197 Visibility
-- Audit upgrade is offered on /order/success ONLY and EXPIRES
-- when the buyer declines it (clicks Skip on the
-- AuditUpgradePanel). After decline, the upgrade can never be
-- re-offered to that buyer — the panel does not re-render on
-- subsequent /order/success visits and the
-- /api/upgrade/audit/{create-session, confirm} endpoints reject
-- the upgrade attempt with 403.
--
-- This column lives on `lead_orders` (the SCAN-tier row created
-- by the $49 score_unlock or $99 list-price unlock checkout) so
-- the decline state is keyed off the original purchase, not the
-- buyer's identity. That's the correct grain because:
--   - Buyer can re-unlock a different scan and get a fresh
--     upsell offer (new lead_orders row, new decline state).
--   - A skipped upsell on one scan order shouldn't poison the
--     unrelated dashboard variant — wait, scratch that, the
--     dashboard variant is being ripped out in the same patch.
--     Still: per-order is the right grain because each order
--     has its own session_id which is the gate the panel uses.
--
-- Nullable + indexed for the rejection-path lookups (the panel
-- render checks `IS NULL` to decide whether to surface the
-- upsell; the endpoints check `IS NOT NULL` to reject).
--
-- See also:
--   /api/upgrade/audit/decline       — POST that stamps this column
--   /api/upgrade/audit/create-session — gated on this column
--   /api/upgrade/audit/confirm        — gated on this column
--   app/order/success/page.tsx        — server-side render gate
--   components/marketing/AuditUpgradePanel.tsx — onSkip wiring

ALTER TABLE lead_orders
  ADD COLUMN IF NOT EXISTS audit_upgrade_declined_at TIMESTAMPTZ;

COMMENT ON COLUMN lead_orders.audit_upgrade_declined_at IS
  'Stamped when the buyer clicks Skip on the AuditUpgradePanel '
  'on /order/success. NULL = upsell still available (default); '
  'NOT NULL = upsell expired, panel does not render + the '
  '/api/upgrade/audit/* endpoints return 403. Page-only policy, '
  'Anthony 2026-06-13.';

-- Index supports the page-render gate (the /order/success server
-- component reads the row's audit_upgrade_declined_at on every
-- render). The column is already part of lead_orders which is
-- queried by stripe_session_id; this composite index lets the
-- declined-check piggyback on the existing session lookup.
CREATE INDEX IF NOT EXISTS lead_orders_stripe_session_audit_decline_idx
  ON lead_orders (stripe_session_id)
  WHERE audit_upgrade_declined_at IS NOT NULL;
