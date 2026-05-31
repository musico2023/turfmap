-- 0036_secure_pulse_pnl_view.sql
--
-- Lock down vw_pulse_buyer_pnl so anon + authenticated clients can't
-- read per-buyer revenue + margin data.
--
-- The view exposes business_name, monthly_price_cents, est_lifetime_
-- revenue_cents, bl_wholesale_cents, est_net_cents, est_net_margin_pct
-- for every Pulse / Pulse+ subscriber. This is internal financial data;
-- not a single column should be readable from a browser.
--
-- Two changes:
--
--   1. `security_invoker = true` — makes the view honor RLS on the
--      underlying tables (clients, citation_orders) instead of
--      bypassing it. Postgres 17's default is SECURITY DEFINER for
--      views created without this clause, which is what triggered
--      the supabase advisor lint security_definer_view.
--
--   2. REVOKE all default grants from PUBLIC / anon / authenticated,
--      then GRANT explicit SELECT only to service_role. The agency
--      operator surfaces that read this view (lib/admin/buyerPnl, the
--      operator P&L dashboard) all use the service-role client.
--
-- Safe to apply blind: idempotent (REVOKE on already-revoked is a
-- no-op, GRANT on already-granted is a no-op). No risk of breaking
-- server-side access since the service-role client bypasses RLS
-- anyway AND we re-grant SELECT to it explicitly.
--
-- Already applied to production via Supabase MCP; this file exists
-- for audit-trail parity with the live schema.

alter view public.vw_pulse_buyer_pnl set (security_invoker = true);

revoke all on public.vw_pulse_buyer_pnl from public;
revoke all on public.vw_pulse_buyer_pnl from anon;
revoke all on public.vw_pulse_buyer_pnl from authenticated;

grant select on public.vw_pulse_buyer_pnl to service_role;
