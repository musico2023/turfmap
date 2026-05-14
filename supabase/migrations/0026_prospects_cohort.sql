-- 0026_prospects_cohort.sql
--
-- Adds cohort isolation for the CRM warm-reactivation campaign
-- (VIP / /freescan) alongside the existing cold-email cohort
-- (MAPCHECK50 / /yourmap).
--
-- A single prospects table serves both campaigns; the `cohort` column
-- is the discriminator. Reporting queries group/filter on it; the
-- /freescan lander and Stage 2 trigger select rows by cohort.
--
-- New columns:
--   cohort               — 'cold_email' (default) | 'crm_reactivation_q2' | future
--   scan_engaged_at      — first dashboard view after VIP TurfScan purchase;
--                          gates Stage 2 email
--   stage_2_sent_at      — set once Stage 2 (audit-upgrade) email has been sent
--   audit_upgrade_url    — personalized URL embedded in Stage 2 email; routes the
--                          recipient to /api/upgrade/audit/create-session with
--                          the UPGRADE_302_CREDIT coupon pre-applied
--   first_name           — recipient's first name (CRM cohort only — used in
--                          Stage 2 email salutation). Backfilled by the CRM
--                          import script for the 27-row reactivation campaign.
--   email                — recipient's email (CRM cohort only — Stage 2 cron
--                          uses this directly; cold-email cohort sends through
--                          Instantly/external infra so this stays null there).
--
-- Safe to re-run. Backfills cohort='cold_email' on all existing rows
-- (which were all created via the cold-email pipeline before this
-- migration). The /freescan retag of the 28 HighLevel-import rows is
-- a separate data migration (see retag_highlevel_import_to_crmvip in
-- the lead-gen project) so the schema change can ship independently.

alter table public.prospects
  add column if not exists cohort text not null default 'cold_email',
  add column if not exists scan_engaged_at timestamptz,
  add column if not exists stage_2_sent_at timestamptz,
  add column if not exists audit_upgrade_url text,
  add column if not exists first_name text,
  add column if not exists email text;

-- Constrain cohort to a known set. Update this list as new campaigns
-- launch. Drop+recreate so re-runs don't error on the existing
-- constraint.
alter table public.prospects
  drop constraint if exists prospects_cohort_check;
alter table public.prospects
  add constraint prospects_cohort_check
  check (cohort in ('cold_email', 'crm_reactivation_q2'));

-- Composite index supports the Stage 2 trigger loop, which scans for
-- (cohort='crm_reactivation_q2', converted_at not null,
--  scan_engaged_at not null, stage_2_sent_at is null) every minute or
-- two via the cron route. Partial index keeps it small as the table
-- grows past the campaign.
create index if not exists prospects_stage2_pending_idx
  on public.prospects (scan_engaged_at)
  where cohort = 'crm_reactivation_q2'
    and stage_2_sent_at is null;

-- Cohort-filtered reporting queries become a single index seek.
create index if not exists prospects_cohort_idx
  on public.prospects (cohort);

comment on column public.prospects.cohort is
  'Campaign cohort. cold_email = original cold-outbound pipeline (MAPCHECK50, /yourmap). crm_reactivation_q2 = CRM warm-reactivation campaign (VIP, /freescan). Drives reporting cuts + per-cohort UX on the lander.';

comment on column public.prospects.scan_engaged_at is
  'First dashboard view after the prospect purchases TurfScan. Stamped by /api/prospect/[id]/engaged. Used as the Stage 2 trigger gate: Stage 2 fires 30 min to 24 hr after this timestamp.';

comment on column public.prospects.stage_2_sent_at is
  'Set when the Stage 2 (audit-upgrade) email is delivered. Idempotency guard — the cron skips rows where this is non-null.';

comment on column public.prospects.audit_upgrade_url is
  'Personalized URL embedded in Stage 2 email. Routes the recipient to /api/upgrade/audit/create-session with the UPGRADE_302_CREDIT coupon pre-applied for $499 - $302 = $197 audit pricing.';
