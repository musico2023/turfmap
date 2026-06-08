-- 0042_cold_funnel_summary_view.sql
--
-- Aggregates cold-funnel events by (utm_campaign, day) into a single
-- queryable row per campaign-day. Powers /admin/cold-funnel (Phase 2)
-- and ad-hoc SQL queries answering the brief's primary question:
--
--   "Is the leak between click → scan (lander) or send → click (email)?"
--
-- Columns:
--   campaign           — utm_campaign value (e.g. 'roofing_orlando_q2_2026')
--   day                — UTC date the events landed
--   emails_sent        — count of prospects in this campaign whose
--                        email_sent_at (from migration 0024) falls
--                        on this day. Source: prospects table (NOT
--                        cold_funnel_events, because send is an
--                        ESP-side event Instantly stamps onto the
--                        prospect row when the message ships).
--   yourmap_view       — distinct prospects that loaded /yourmap
--   yourmap_scroll_50  — distinct prospects that scrolled past 50%
--   yourmap_scroll_form — distinct prospects whose viewport hit CTA
--   coldscan_cta_click — distinct prospects that clicked the CTA
--   free_scan_started  — distinct prospects that triggered scan exec
--   free_scan_completed — distinct prospects that landed on /share
--
-- Each step uses COUNT(DISTINCT prospect_id) so re-firing the same
-- event for the same prospect (idempotent client retries, refresh,
-- React strict-mode double-fires) doesn't inflate.
--
-- The view is read-only and service-role only — same posture as
-- prospects + cold_funnel_events.

create or replace view public.cold_funnel_summary as
with funnel_by_campaign_day as (
  -- Bucket every funnel event into (campaign, UTC day) and count
  -- distinct prospects per event_type. COALESCE the campaign to
  -- '(no_campaign)' so events that arrived without a utm_campaign
  -- (manual visits, link-stripped clicks) still show up rather than
  -- silently disappearing.
  select
    coalesce(utm_campaign, '(no_campaign)') as campaign,
    (created_at at time zone 'utc')::date as day,
    count(distinct prospect_id) filter (where event_type = 'yourmap_view') as yourmap_view,
    count(distinct prospect_id) filter (where event_type = 'yourmap_scroll_50') as yourmap_scroll_50,
    count(distinct prospect_id) filter (where event_type = 'yourmap_scroll_form') as yourmap_scroll_form,
    count(distinct prospect_id) filter (where event_type = 'coldscan_cta_click') as coldscan_cta_click,
    count(distinct prospect_id) filter (where event_type = 'free_scan_started') as free_scan_started,
    count(distinct prospect_id) filter (where event_type = 'free_scan_completed') as free_scan_completed
  from public.cold_funnel_events
  group by 1, 2
),
sends_by_campaign_day as (
  -- email_campaign on prospects is the same vocabulary as
  -- utm_campaign in the email URLs (the lead-gen pipeline mints both
  -- from the same source). email_sent_at (from migration 0024) is
  -- the canonical "first email sent" timestamp — Instantly stamps
  -- this on the prospect row when the message ships. NOTE: the
  -- system uses email_sent_at for stage 1; stage_2_sent_at +
  -- stage_3_sent_at (from later migrations) cover the follow-up
  -- touches but are not relevant to the click→scan funnel.
  select
    coalesce(email_campaign, '(no_campaign)') as campaign,
    (email_sent_at at time zone 'utc')::date as day,
    count(*) as emails_sent
  from public.prospects
  where email_sent_at is not null
  group by 1, 2
)
select
  coalesce(f.campaign, s.campaign) as campaign,
  coalesce(f.day, s.day) as day,
  coalesce(s.emails_sent, 0) as emails_sent,
  coalesce(f.yourmap_view, 0) as yourmap_view,
  coalesce(f.yourmap_scroll_50, 0) as yourmap_scroll_50,
  coalesce(f.yourmap_scroll_form, 0) as yourmap_scroll_form,
  coalesce(f.coldscan_cta_click, 0) as coldscan_cta_click,
  coalesce(f.free_scan_started, 0) as free_scan_started,
  coalesce(f.free_scan_completed, 0) as free_scan_completed,

  -- Convenience drop-rates. Computed as ratios on the same (campaign,
  -- day) row so an operator can read them at a glance. NULL when the
  -- denominator is zero (avoids divide-by-zero) — display layer
  -- should render '—' for null. Multiplied by 100 + rounded to 1dp
  -- so the column values are human-readable percentages, not 0.xx
  -- floats.
  case
    when coalesce(s.emails_sent, 0) = 0 then null
    else round(100.0 * coalesce(f.yourmap_view, 0) / s.emails_sent, 1)
  end as send_to_view_pct,
  case
    when coalesce(f.yourmap_view, 0) = 0 then null
    else round(100.0 * coalesce(f.coldscan_cta_click, 0) / f.yourmap_view, 1)
  end as view_to_cta_pct,
  case
    when coalesce(f.coldscan_cta_click, 0) = 0 then null
    else round(100.0 * coalesce(f.free_scan_started, 0) / f.coldscan_cta_click, 1)
  end as cta_to_scan_start_pct,
  case
    when coalesce(f.free_scan_started, 0) = 0 then null
    else round(100.0 * coalesce(f.free_scan_completed, 0) / f.free_scan_started, 1)
  end as scan_start_to_complete_pct,

  -- End-to-end guardrail. This is the metric in Section 9 of the brief.
  case
    when coalesce(s.emails_sent, 0) = 0 then null
    else round(100.0 * coalesce(f.free_scan_completed, 0) / s.emails_sent, 1)
  end as send_to_scan_pct
from funnel_by_campaign_day f
full outer join sends_by_campaign_day s
  on f.campaign = s.campaign and f.day = s.day
order by coalesce(f.day, s.day) desc, coalesce(f.campaign, s.campaign);

comment on view public.cold_funnel_summary is
  'Per (utm_campaign, day) funnel rollup. Joins prospects.stage_1_sent_at (email sends from Instantly) with cold_funnel_events (site-side events). Answers the brief''s primary question: is the leak the email or the lander? See migration 0042.';
