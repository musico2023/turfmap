-- 0047 — widen cold_funnel_events event_type vocabulary
--
-- Migration 0041 defined a closed set of 6 event types on the CHECK
-- constraint. v2.2 §P0.2 + §9.3 introduce five more we need in the
-- same table (single write path, §12):
--
--   reply_received      — Instantly reply, classified positive/negative/ambiguous
--                          (classification piggybacks on utm_medium; see
--                          lib/analytics/replyFanout.ts)
--   mail_scanned        — Postalytics PURL scan → physical→digital promotion
--   mail_sent           — Postalytics campaign_sent webhook
--   mail_delivered      — Postalytics piece_delivered webhook (telemetry only)
--   mail_bounced        — Postalytics hard_bounce (undeliverable)
--   mail_address_flag   — Postalytics address_correction event
--
-- Drop + recreate the CHECK constraint with the wider vocab.

alter table public.cold_funnel_events
  drop constraint if exists cold_funnel_events_event_type_check;

alter table public.cold_funnel_events
  add constraint cold_funnel_events_event_type_check
  check (
    event_type = any (array[
      -- Original 0041 vocab (unchanged):
      'yourmap_view',
      'yourmap_scroll_50',
      'yourmap_scroll_form',
      'coldscan_cta_click',
      'free_scan_started',
      'free_scan_completed',
      -- v2.2 §P0.2 reply flow:
      'reply_received',
      -- v2.2 §9.3 Postalytics webhook events:
      'mail_scanned',
      'mail_sent',
      'mail_delivered',
      'mail_bounced',
      'mail_address_flag'
    ]::text[])
  );

comment on constraint cold_funnel_events_event_type_check on public.cold_funnel_events
  is 'Closed vocab. Widened in 0047 for v2.2 reply + Postalytics events. Any new event needs a migration bump.';
