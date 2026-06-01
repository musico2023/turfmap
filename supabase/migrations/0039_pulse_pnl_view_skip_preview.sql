-- 0039_pulse_pnl_view_skip_preview.sql
--
-- Drop & recreate vw_pulse_buyer_pnl with a `c.is_preview = false`
-- filter so /score lead-magnet preview clients don't pollute the
-- operator's per-buyer P&L.
--
-- Without this filter, a preview client that happens to fall under
-- billing_mode 'agency_managed' (which createPreviewClient sets to
-- keep the row invisible everywhere else) would show up in the P&L
-- view with revenue=NULL and margin=NULL — looking like an agency-
-- managed client whose revenue isn't tracked in subscription. That's
-- noise; preview clients should not appear at all until they convert.
--
-- The view's other filters (billing_mode in pulse/pulse_plus/
-- agency_managed; tier in pulse/pulse_plus) are unchanged. We're
-- only narrowing further with the is_preview=false predicate.
--
-- The view also keeps its security_invoker=true + grants from 0036
-- (REVOKE anon+authenticated, GRANT service_role) — those carry
-- across the CREATE OR REPLACE because we're only changing the
-- WHERE clause, not the column list. Migration 0036's grants stay
-- in effect on the new view definition.
--
-- Already applied to production via Supabase MCP; this file exists
-- for audit-trail parity with the live schema.

drop view if exists public.vw_pulse_buyer_pnl;

create view public.vw_pulse_buyer_pnl
  with (security_invoker = true)
as
with months as (
  select
    c.id as client_id,
    floor(extract(epoch from (now() - c.created_at)) / 86400)::int as days_active,
    round(
      (extract(epoch from (now() - c.created_at)) / 86400)::numeric / 30.4,
      2
    ) as months_active
  from public.clients c
),
bl_costs as (
  select
    co.client_id,
    sum(coalesce(co.wholesale_cents, 0)) as total_wholesale_cents,
    sum(coalesce(co.billed_cents, 0)) as total_billed_to_buyer_cents,
    count(*) as citation_order_count,
    bool_or(co.created_at < timestamptz '2026-05-17') as has_pre_recalibration_estimate,
    min(co.created_at) as first_build_at,
    max(co.created_at) as latest_build_at
  from public.citation_orders co
  group by co.client_id
)
select
  c.id as client_id,
  c.business_name,
  c.tier,
  c.billing_mode,
  c.status,
  c.created_at as signup_at,
  m.days_active,
  m.months_active,
  c.monthly_price_cents,
  case
    when c.monthly_price_cents is not null
      then round((c.monthly_price_cents * m.months_active)::numeric)::bigint
    else null
  end as est_lifetime_revenue_cents,
  coalesce(b.total_wholesale_cents, 0) as bl_wholesale_cents,
  coalesce(b.total_billed_to_buyer_cents, 0) as resync_charges_to_buyer_cents,
  coalesce(b.citation_order_count, 0) as citation_orders_count,
  b.first_build_at,
  b.latest_build_at,
  round((500 * m.months_active)::numeric)::bigint as est_ops_cost_cents,
  case
    when c.monthly_price_cents is not null
      then round(
        (
          (c.monthly_price_cents * m.months_active)
          + coalesce(b.total_billed_to_buyer_cents, 0)
          - coalesce(b.total_wholesale_cents, 0)
          - (500 * m.months_active)
        )::numeric
      )::bigint
    else null
  end as est_net_cents,
  case
    when c.monthly_price_cents is not null
     and (c.monthly_price_cents * m.months_active) > 0
      then round(
        100.0 * (
          (c.monthly_price_cents * m.months_active)
          + coalesce(b.total_billed_to_buyer_cents, 0)
          - coalesce(b.total_wholesale_cents, 0)
          - (500 * m.months_active)
        )::numeric
        / nullif(c.monthly_price_cents * m.months_active, 0)::numeric,
        1
      )
    else null
  end as est_net_margin_pct,
  case
    when c.billing_mode = 'agency_managed' then 'agency_managed: revenue tracked in contract, not subscription'
    when c.monthly_price_cents is null then 'no MRR set: P&L incomplete'
    when coalesce(b.has_pre_recalibration_estimate, false)
      then 'stale BL estimate: row created pre-2026-05-17, wholesale_cents likely under-reported'
    else 'reliable'
  end as data_quality
from public.clients c
join months m on m.client_id = c.id
left join bl_costs b on b.client_id = c.id
where c.billing_mode in ('pulse', 'pulse_plus', 'agency_managed')
  and c.tier in ('pulse', 'pulse_plus')
  -- /score lead-magnet preview clients are intentionally invisible
  -- here until they convert via the $99 unlock (which flips
  -- is_preview=false).
  and c.is_preview = false
order by c.created_at desc;

revoke all on public.vw_pulse_buyer_pnl from public;
revoke all on public.vw_pulse_buyer_pnl from anon;
revoke all on public.vw_pulse_buyer_pnl from authenticated;
grant select on public.vw_pulse_buyer_pnl to service_role;

comment on view public.vw_pulse_buyer_pnl is
  'Per-buyer P&L for Pulse / Pulse+ subscribers. Revenue is ESTIMATED '
  'from monthly_price_cents × fractional months_active when set. '
  'agency_managed clients have null revenue here — their revenue is '
  'tracked in your agency contract. BL wholesale comes from '
  'citation_orders.wholesale_cents which is our INTERNAL estimate at '
  'insert time, not the real BL invoice — see data_quality column. '
  'Ops cost flat $5/mo per buyer. is_preview=true clients (the '
  '/score lead-magnet preview cohort) are excluded.';
