-- 0021_outreach_leads.sql
--
-- Adds clients.is_outreach_lead — flags rows created by outreach
-- enrichment (scripts/enrich-leads.ts) so they don't pollute the
-- agency-facing /clients listing or the recurring cron pipelines.
--
-- These rows back the personalized email-campaign share links: a
-- prospect from the past-leads CSV gets a row inserted, a real DFS
-- scan run against their geocoded business, and a share-link URL
-- they can click to see their TurfScore. They're full clients
-- structurally — same scans + scan_points + scan_share_links — but
-- with billing_mode='agency_managed' and is_outreach_lead=true so
-- they only surface where we need them (the share-link itself, plus
-- a separate /clients/outreach lead-pipeline view if/when we add one).
--
-- Flagged surfaces filter on `is_outreach_lead = false`:
--   - /clients agency listing
--   - weekly-scans cron (don't keep scanning prospects we're not
--     billing for)
--   - weekly-competitor-summary cron (no buyer to email)
--   - check-scan-delivery cron (no refund window)
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table clients
  add column if not exists is_outreach_lead boolean not null default false;

create index if not exists clients_is_outreach_lead_idx
  on clients (is_outreach_lead)
  where is_outreach_lead = true;

comment on column clients.is_outreach_lead is
  'TRUE for clients rows created by outreach enrichment (cold-lead campaigns). Hides from agency listing + cron pipelines. Backs the personalized share-link URL each prospect receives.';
