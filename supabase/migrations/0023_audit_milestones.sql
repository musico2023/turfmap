-- 0023_audit_milestones.sql
--
-- Phase 3 — auto-fulfillment cron + email pipeline.
--
-- Adds timestamp columns to visibility_audits that gate the daily
-- /api/cron/audit-milestones sweep. Each column is set to NOW()
-- when the corresponding email lands; the sweep filters on IS NULL
-- so a re-run never double-sends.
--
-- Migration is additive — no existing column shapes change. Safe to
-- apply against a populated table.

-- ─── Milestone-email tracking ─────────────────────────────────────────

alter table visibility_audits
  add column if not exists prep_email_sent_at timestamptz;

comment on column visibility_audits.prep_email_sent_at is
  'Set when the 24h-pre-call Strategist Prep email (Roadmap PDF + prep notes) lands at anthony@fourdots.io. Cron filters on IS NULL to find audits inside the 23-25h pre-call window that need the email; once sent, the row stamps + the next sweep skips it.';

alter table visibility_audits
  add column if not exists day_25_reminder_sent_at timestamptz;

comment on column visibility_audits.day_25_reminder_sent_at is
  'Day-25 buyer re-scan reminder. Fires from the milestone cron when (call_completed_at + 25d) lands inside the sweep window.';

alter table visibility_audits
  add column if not exists day_67_followup_sent_at timestamptz;

comment on column visibility_audits.day_67_followup_sent_at is
  'Day-67 buyer follow-up reminder. Fires only when (sixty_day_check_scheduled_at IS NULL) — i.e., the buyer has not yet booked the 60-day check-in.';

-- sixty_day_prompted_at already exists from migration 0022. We use
-- it as the day-53 prompt-sent gate.

-- ─── Cron sweep performance index ─────────────────────────────────────
--
-- The milestone sweep filters on combinations of strategist_call_*
-- timestamps + the new _sent_at columns. Existing
-- visibility_audits_milestone_idx covers the call-completed cases;
-- this adds one for the pre-call case (the 24h prep-email window).

create index if not exists visibility_audits_pre_call_idx
  on visibility_audits (strategist_call_scheduled_at)
  where strategist_call_scheduled_at is not null
    and prep_email_sent_at is null;

-- ─── PDF + prep-notes storage ─────────────────────────────────────────
--
-- These columns existed in 0022 (roadmap_pdf_url, prep_notes_url) but
-- weren't yet populated. Phase 3 cron writes them as part of the
-- 24h-pre-call generation. No schema change here — just calling out
-- in the migration log that they go live in this phase.
