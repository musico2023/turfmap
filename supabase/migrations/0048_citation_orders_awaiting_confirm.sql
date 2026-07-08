-- 0048_citation_orders_awaiting_confirm.sql
--
-- Add 'awaiting_confirm' to the citation_orders status vocabulary.
--
-- BrightLocal runs an async "citation lookup" (Citation Tracker searching)
-- on every newly-created Citation Builder campaign, and the confirm/pay
-- endpoint returns 400 not_ready until that lookup completes. Our old flow
-- confirmed immediately after create → the confirm failed with not_ready,
-- and because we persisted the order only AFTER a successful confirm, the
-- BL campaign was left orphaned with no local record (e.g. D Spot Dessert
-- Cafe / campaign 981600).
--
-- New flow: persist the order right after create in status
-- 'awaiting_confirm', attempt confirm with a short in-request retry, and
-- let the hourly poll-citations cron finalize (confirm/pay) any
-- 'awaiting_confirm' order once BL's lookup is complete. This status marks
-- "campaign created + persisted, not yet paid — pending BL lookup".

alter table public.citation_orders
  drop constraint if exists citation_orders_status_check;

alter table public.citation_orders
  add constraint citation_orders_status_check
  check (status in (
    'awaiting_confirm', 'queued', 'in_progress', 'complete', 'partial', 'failed'
  ));
