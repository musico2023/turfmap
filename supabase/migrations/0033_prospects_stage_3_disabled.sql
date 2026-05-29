-- 0033_prospects_stage_3_disabled.sql
--
-- Add `prospects.stage_3_disabled_at` — explicit halt marker for the
-- cold-stage3 Visibility Audit auto-pitch.
--
-- Trigger semantics:
--   - poll-replies cron stamps this AUTOMATICALLY when it detects a
--     new reply from a prospect who already received Stage 2 (their
--     latest inbound timestamp > stage_2_sent_at). Signal: prospect is
--     actively in conversation; operator wants to pitch the audit
--     personably in-thread instead of letting the cron fire the
--     standard founder-from-anthony@fourdots.io Stage 3 email.
--   - operator can stamp it MANUALLY via /api/admin/disable-cold-stage3
--     for any prospect they want to handle personally, regardless of
--     reply state.
--
-- cold-stage3 cron's candidate query adds `.is('stage_3_disabled_at',
-- null)` so disabled prospects drop out of the auto-pitch sweep.
--
-- Once disabled, the prospect can still receive Stage 3 manually via
-- a future operator endpoint (or by NULL-ing the column and waiting
-- for the cron's natural window). Reads as "the auto-pitch is OFF
-- for this prospect" semantically.

ALTER TABLE prospects
ADD COLUMN IF NOT EXISTS stage_3_disabled_at TIMESTAMPTZ;

COMMENT ON COLUMN prospects.stage_3_disabled_at IS
  'Halt marker for the cold-stage3 audit auto-pitch. Set by poll-replies when a post-Stage-2 reply is detected, or manually via /api/admin/disable-cold-stage3. cold-stage3 cron filters this IS NULL to skip the automated send.';
