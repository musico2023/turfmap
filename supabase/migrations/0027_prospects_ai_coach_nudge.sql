-- 0027_prospects_ai_coach_nudge.sql
--
-- AI Coach engagement nudge for prospects who scanned but didn't click
-- "Generate" on the AI Coach. The first real VIP buyer (Ryan / BVM
-- Contracting) demonstrated this gap clearly — he opened his dashboard
-- within 1 second of conversion but never engaged the AI Coach, which
-- is the upsell-bridge surface inside the free TurfScan experience.
--
-- This migration adds the idempotency stamp + partial index used by
-- `/api/cron/ai-coach-nudge` (registered in vercel.json, every 15 min).
--
-- Trigger conditions for the nudge email (all must be true):
--   - prospects.converted_at IS NOT NULL          (purchased TurfScan)
--   - prospects.scan_engaged_at IS NOT NULL       (viewed dashboard)
--   - prospects.ai_coach_nudge_sent_at IS NULL    (not nudged before)
--   - NOW() - scan_engaged_at >= 1 hour           (gave them a chance)
--   - NOW() - scan_engaged_at <= 7 days           (still a warm lead)
--   - NO row in ai_insights for the buyer's most-recent scan
--
-- Cohort scope: applies to BOTH cold_email and crm_reactivation_q2.
-- AI Coach is the upsell bridge in both funnels, and the nudge is
-- behaviorally neutral — "you didn't click the button" doesn't depend
-- on how the buyer got there.
--
-- All ALTER TABLE statements use `IF NOT EXISTS` guards so this
-- migration is safe to re-run.

-- ─── 1. Column ──────────────────────────────────────────────────────
alter table public.prospects
  add column if not exists ai_coach_nudge_sent_at timestamptz;

-- ─── 2. Partial index for the cron's hot path ───────────────────────
-- Candidates are prospects with scan_engaged_at set + nudge not yet
-- sent. Partial predicate keeps the index small (target population is
-- a few hundred rows max across cold + warm cohorts in any given
-- 7-day window).
create index if not exists prospects_ai_coach_nudge_pending_idx
  on public.prospects (scan_engaged_at)
  where converted_at is not null
    and scan_engaged_at is not null
    and ai_coach_nudge_sent_at is null;

-- ─── 3. Document ────────────────────────────────────────────────────
comment on column public.prospects.ai_coach_nudge_sent_at is
  'When the AI Coach engagement-nudge email was sent. NULL = not '
  'yet sent. Cron at /api/cron/ai-coach-nudge fires once per '
  'prospect when 1 hour has passed since scan_engaged_at without '
  'an ai_insights row appearing for the buyer''s scan.';
