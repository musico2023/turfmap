-- 0026_prospects_cohort.sql
--
-- Cohort discriminator + warm-reactivation Stage 2 trigger columns on
-- prospects. Powers the CRM warm-reactivation Q2 2026 campaign
-- (`crm_reactivation_q2` cohort) per VIP_HANDOFF.md / MARKETING_BRIEF.
--
-- The cohort column splits prospects.business_name's audience by source:
--   - 'cold_email'           — original Apify-scraped cold-email cohort
--   - 'crm_reactivation_q2'  — 28 Fourdots HighLevel warm leads (Q2 '26)
-- More cohorts can be added later by extending the CHECK constraint.
--
-- Stage 2 trigger columns (`scan_engaged_at`, `stage_2_sent_at`,
-- `audit_upgrade_url`) are populated by:
--   - POST /api/prospect/[id]/engaged    → scan_engaged_at on first
--                                          dashboard view (warm cohort)
--   - /api/cron/crmvip-stage2 every 15m → stage_2_sent_at + URL
--
-- `first_name` + `email` are denormalized from the HighLevel import
-- (mailbox + personalization fields for Stage 1 hand-sending and Stage 2
-- cron). Cold-email cohort rows leave these null; the Stage 2 cron only
-- considers crm_reactivation_q2 rows, so the asymmetry is fine.
--
-- All ALTER TABLE statements use `IF NOT EXISTS` guards so this migration
-- is safe to re-run.

-- ─── 1. Columns ─────────────────────────────────────────────────────
alter table public.prospects
  add column if not exists cohort text,
  add column if not exists scan_engaged_at timestamptz,
  add column if not exists stage_2_sent_at timestamptz,
  add column if not exists audit_upgrade_url text,
  add column if not exists first_name text,
  add column if not exists email text;

-- ─── 2. Backfill cohort on pre-existing rows ────────────────────────
-- Pre-existing rows are all from the cold-email cohort. Set the default
-- here so the CHECK constraint below doesn't reject them when added.
update public.prospects
  set cohort = 'cold_email'
  where cohort is null;

-- ─── 3. CHECK constraint on cohort ──────────────────────────────────
-- Validates against the known cohort list. Drop + re-add so a re-run
-- with extended values doesn't bail on the constraint-already-exists
-- error. Idempotent via DO block.
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
    check (cohort in ('cold_email', 'crm_reactivation_q2'));
end$$;

-- ─── 4. Indexes ─────────────────────────────────────────────────────
-- Partial index on the Stage 2 cron's hot path: scan candidates are
-- cohort='crm_reactivation_q2' + stage_2_sent_at IS NULL. The partial
-- predicate keeps the index small (only ~28 rows in this campaign +
-- future cohort batches).
create index if not exists prospects_crmvip_stage2_pending_idx
  on public.prospects (scan_engaged_at)
  where cohort = 'crm_reactivation_q2' and stage_2_sent_at is null;

-- General-purpose index on cohort for reporting / funnel queries that
-- group by cohort. Small table, low write rate — cheap to maintain.
create index if not exists prospects_cohort_idx
  on public.prospects (cohort);

-- ─── 5. Document ────────────────────────────────────────────────────
comment on column public.prospects.cohort is
  'Source cohort. cold_email = original Apify scrape; '
  'crm_reactivation_q2 = HighLevel warm reactivation (Q2 2026). '
  'Drives the Stage 2 audit-upgrade email cron.';
comment on column public.prospects.scan_engaged_at is
  'First dashboard view timestamp after the buyer purchased their '
  'free TurfScan (warm cohort only). Triggers the 30-min/24-hr '
  'Stage 2 email window.';
comment on column public.prospects.stage_2_sent_at is
  'When the Stage 2 audit-upgrade email was sent. NULL = not yet sent.';
comment on column public.prospects.audit_upgrade_url is
  'The exact /audit-upgrade?source=stage_2_email&prospect_id=... URL '
  'embedded in the Stage 2 email. Stamped at send time so operators '
  'can re-resolve from Resend delivery logs.';
