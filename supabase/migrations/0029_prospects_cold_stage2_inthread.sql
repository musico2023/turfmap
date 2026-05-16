-- 0029_prospects_cold_stage2_inthread.sql
--
-- Adds the scheduling + threading columns the cold-email Stage 2 in-thread
-- send needs. Powers the 11-min-delay-then-reply-in-thread flow:
--
--   1. /api/cron/instantly-poll-replies runs every 2 min.
--   2. On a positive reply: stash the reply's Instantly UUID + the
--      sender mailbox (eaccount), set stage_2_scheduled_at = NOW + 11min,
--      DO NOT send yet.
--   3. Each cron tick also scans for prospects where stage_2_scheduled_at
--      is in the past and stage_2_sent_at IS NULL — those are due to send.
--      Cron calls Instantly's /api/v2/emails/reply with the stashed UUID +
--      eaccount + rendered HTML. Reply ships in-thread from the same
--      mailbox. Cron stamps stage_2_sent_at.
--
-- Why split scheduling from sending:
--   - Resend's scheduledAt would have given us native delayed send, but
--     it sends from OUR domain (hi@turfmap.ai), breaking thread continuity.
--   - Instantly's API has no native scheduled-send. So we manage the
--     "send at" timestamp ourselves and let the cron poll for due rows.
--   - The 11-min delay is approximate (cron interval is 2 min). Effective
--     delay range: 11–13 min from positive reply. Acceptable per brief.
--
-- All ALTER TABLE statements use IF NOT EXISTS guards — safe to re-run.

alter table public.prospects
  -- When Stage 2 is due to send (stamped by the classifier branch of
  -- /api/cron/instantly-poll-replies on positive reply). NULL = either
  -- not yet replied, or reply was classified negative/ambiguous.
  add column if not exists stage_2_scheduled_at timestamptz,

  -- The Instantly UUID of the prospect's reply email (`emails.id`). Required
  -- by POST /api/v2/emails/reply as `reply_to_uuid` so Instantly stitches
  -- the new reply into the same thread.
  add column if not exists instantly_reply_uuid text,

  -- The Instantly mailbox (eaccount) the original cold email was sent from
  -- — e.g. 'philip@breakthroughactivate.com'. POST /api/v2/emails/reply
  -- requires this to know which mailbox to send the reply from. Captured
  -- at classification time from the inbound reply's eaccount field.
  add column if not exists instantly_eaccount text,

  -- The full subject string from the inbound reply, so the in-thread send
  -- can construct a proper "Re: <original subject>" subject line. Some
  -- inbound replies (especially auto-replies) already include "Re:" or
  -- vendor-prefixed text; we let the cron normalize at send time rather
  -- than at capture time.
  add column if not exists instantly_reply_subject text;

-- Partial index on the cron's second-pass hot path: rows with a scheduled
-- send that hasn't fired yet. Tiny — usually only a handful of rows at any
-- given time because the cron drains them within minutes.
create index if not exists prospects_cold_stage2_due_idx
  on public.prospects (stage_2_scheduled_at)
  where stage_2_scheduled_at is not null
    and stage_2_sent_at is null
    and cohort = 'cold_email_q2_2026';

comment on column public.prospects.stage_2_scheduled_at is
  'When the cold-cohort Stage 2 (reply-response with TurfScan link) email '
  'is due to send. Set by /api/cron/instantly-poll-replies after positive '
  'reply classification. Same cron polls for due rows on its next pass.';

comment on column public.prospects.instantly_reply_uuid is
  'Instantly email UUID of the prospect''s reply. Used as reply_to_uuid '
  'in POST /api/v2/emails/reply so the Stage 2 send threads correctly.';

comment on column public.prospects.instantly_eaccount is
  'Instantly mailbox identifier (e.g. philip@breakthroughactivate.com) '
  'that the original cold email was sent from. Stage 2 reply ships from '
  'this same mailbox to preserve thread + sender persona continuity.';

comment on column public.prospects.instantly_reply_subject is
  'Subject of the inbound reply. Used to construct the Re: <subject> on '
  'the Stage 2 in-thread send.';
