-- 0040_nap_audits_trigger_source.sql
--
-- Adds `trigger_source` text column to nap_audits so we can track
-- provenance ("scan" vs. "audit-init" vs. "ai-coach" vs. "manual")
-- WITHOUT abusing the triggered_by FK-to-users column.
--
-- Background: pre-0040, the audit-init pathway in
-- lib/audit/triggerNapAuditAtAuditInit.ts passed the literal string
-- 'audit-init' as triggered_by. Postgres rejected the insert with
-- "invalid input syntax for type uuid" since triggered_by has a FK
-- constraint on users(id), and the row never landed. The fire-and-
-- forget caller swallowed the error via console.error, leaving
-- nap_audits silently empty for every cold-prospect bootstrap
-- (CertaPro 2026-06-08 + likely all prior audit-init firings).
--
-- The string-FK-abuse fix landed in b95ff07 (pass null to
-- triggered_by). This migration restores the provenance signal as
-- a proper text column so operators querying nap_audits can answer
-- "which call site fired this audit" without log-spelunking.
--
-- Column: nullable for backward compatibility (existing rows stay
-- NULL; new rows get a specific value). CHECK constraint enforces
-- the closed set of known values so a typo can't silently land an
-- unknown source string.

ALTER TABLE public.nap_audits
  ADD COLUMN IF NOT EXISTS trigger_source text;

ALTER TABLE public.nap_audits
  ADD CONSTRAINT nap_audits_trigger_source_check
  CHECK (
    trigger_source IS NULL
    OR trigger_source = ANY (ARRAY[
      'scan',         -- post-scan auto-fire in lib/scans/runScan.ts
      'audit-init',   -- visibility audit bootstrap / fulfill init
      'ai-coach',     -- self-heal at AI Coach generation time
      'manual',       -- operator-triggered via admin endpoint
      'cron'          -- future scheduled refresh cron
    ]::text[])
  );

COMMENT ON COLUMN public.nap_audits.trigger_source IS
  'Provenance of the audit trigger. See migration 0040.';
