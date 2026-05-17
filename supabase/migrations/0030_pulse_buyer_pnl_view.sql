-- 0030_pulse_buyer_pnl_view.sql
--
-- vw_pulse_buyer_pnl — per-buyer P&L for Pulse / Pulse+ subscribers.
-- One row per recurring-tier client. Surfaces revenue collected vs
-- BL wholesale paid vs estimated ops costs so the operator can spot
-- a buyer whose unit economics are slipping (over-cap resync events,
-- abnormally large build cost, fast churn, etc.) before it shows up
-- on the monthly P&L.
--
-- Already applied to production via Supabase MCP; this file exists
-- for audit-trail parity with the live schema.
--
-- Revenue is ESTIMATED from `clients.monthly_price_cents × months_active`
-- because Stripe invoices aren't synced to a local table yet. For
-- `agency_managed` clients (Anthony manages directly, charges via
-- agency contract), monthly_price_cents is null and the view sets
-- revenue + net + margin to null — the data_quality column flags
-- this explicitly.
--
-- BL wholesale aggregates citation_orders.wholesale_cents across ALL
-- of a client's locations. wholesale_cents is what we ESTIMATE at
-- insert time (lib/brightlocal/citationBuilder.ts:estimatePackageCostCents),
-- NOT the real BL invoice. Estimates were recalibrated 2026-05-17
-- against a real BL invoice; rows created before that date use the
-- old optimistic numbers ($80 for cb15 vs ~$133 calibrated). The
-- data_quality column flags pre-recalibration rows.
--
-- Ops cost is a flat $5/month per buyer covering DFS scans + Claude
-- AI Coach + DFS NAP audit + Resend + Vercel allocation. Real ops
-- varies but $5/mo is a conservative ceiling.

drop view if exists public.vw_pulse_buyer_pnl;

create view public.vw_pulse_buyer_pnl as
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
order by c.created_at desc;

comment on view public.vw_pulse_buyer_pnl is
  'Per-buyer P&L for Pulse / Pulse+ subscribers. Revenue is ESTIMATED '
  'from monthly_price_cents × fractional months_active when set. '
  'agency_managed clients have null revenue here — their revenue is '
  'tracked in your agency contract. BL wholesale comes from '
  'citation_orders.wholesale_cents which is our INTERNAL estimate at '
  'insert time, not the real BL invoice — see data_quality column. '
  'Ops cost flat $5/mo per buyer.';
