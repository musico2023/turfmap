-- 0028_prospects_cold_email_q2_cohort.sql
--
-- Adds the cold-email reply-driven cohort (`cold_email_q2_2026`) and the
-- Stage 3 trigger column (`stage_3_sent_at`) on prospects. Powers the
-- cold-email pivot from transaction-first ($49 TurfScan in body) to
-- reply-driven (free scan after positive reply, then free Visibility
-- Audit + calendar booking offer).
--
-- Cohort design:
--   - 'cold_email'          — legacy Apify-scraped cold-email cohort (Phase 1/2,
--                             $49 transaction in email body, MAPCHECK50 coupon).
--                             Kept intact for in-flight prospects; not used
--                             for NEW pushes going forward.
--   - 'crm_reactivation_q2' — VIP warm cohort (HighLevel reactivation, free
--                             scan + $197 audit upsell). UNCHANGED.
--   - 'cold_email_q2_2026'  — NEW. Reply-driven flow. Reply 'yes' → free
--                             scan with COLDSCAN coupon → dashboard view →
--                             Stage 3 email offers free Visibility Audit
--                             with calendar booking. No paid step.
--
-- Stage 3 trigger column:
--   - stage_3_sent_at — when the cold-cohort Stage 3 (audit offer) email
--                       was sent. NULL = pending or out of window. The
--                       /api/cron/cold-stage3 cron fires every 15 min
--                       targeting prospects with cohort='cold_email_q2_2026'
--                       in the 30min-24hr scan_engaged_at window.
--
-- All ALTER TABLE statements use `IF NOT EXISTS` guards so this migration
-- is safe to re-run.

-- ─── 1. Columns ─────────────────────────────────────────────────────
alter table public.prospects
  add column if not exists stage_3_sent_at timestamptz,
  -- Set when /api/webhooks/instantly-reply classifies a reply as
  -- negative (pass / unsubscribe / "not interested"). Blocks all
  -- downstream automated emails (Stage 2, Stage 3) for this prospect.
  add column if not exists unsubscribed_at timestamptz;

-- ─── 2. Extend cohort CHECK constraint ──────────────────────────────
-- Drop + re-add to include the new value. Idempotent via DO block.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'prospects_cohort_check'
  ) then
    alter table public.prospects drop constraint prospects_cohort_check;
  end if;
  alter table public.prospects
    add constraint prospects_cohort_check
    check (cohort in (
      'cold_email',           -- legacy transactional cold-email cohort
      'crm_reactivation_q2',  -- VIP warm cohort (unchanged)
      'cold_email_q2_2026'    -- reply-driven cold-email cohort (this migration)
    ));
end$$;

-- ─── 3. Indexes ─────────────────────────────────────────────────────
-- Partial index on the Stage 3 cron's hot path: cohort match +
-- stage_3_sent_at IS NULL. Tiny — only ~hundreds of rows at any time
-- since the cron clears rows out quickly.
create index if not exists prospects_cold_q2_stage3_pending_idx
  on public.prospects (scan_engaged_at)
  where cohort = 'cold_email_q2_2026' and stage_3_sent_at is null;

-- ─── 4. Document ────────────────────────────────────────────────────
comment on column public.prospects.stage_3_sent_at is
  'When the cold-cohort Stage 3 (free Visibility Audit + calendar) email '
  'was sent. NULL = pending or out of the 30min-24hr post-engagement '
  'window. Stamped by /api/cron/cold-stage3.';

comment on column public.prospects.unsubscribed_at is
  'When the prospect replied with negative intent ("pass", "unsubscribe", '
  '"not interested", etc.). Set by /api/webhooks/instantly-reply after '
  'Claude Haiku classifies the inbound reply. Blocks all downstream '
  'automated emails (Stage 2 reply-response, Stage 3 audit offer).';

-- ─── 5. Filter Stage 3 cron on unsubscribed_at IS NULL ──────────────
-- The cron's WHERE clause should already filter; this drops + recreates
-- the partial index to include the new unsubscribed guard, so the index
-- stays selective.
drop index if exists prospects_cold_q2_stage3_pending_idx;
create index if not exists prospects_cold_q2_stage3_pending_idx
  on public.prospects (scan_engaged_at)
  where cohort = 'cold_email_q2_2026'
    and stage_3_sent_at is null
    and unsubscribed_at is null;
