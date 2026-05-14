-- 0017_drop_gbp_url.sql
--
-- Drops client_locations.gbp_url. The column was added in 0006 with
-- the intent of plumbing it into the audit pipeline later, but it
-- never got wired to anything downstream — not the scan engine, not
-- the citation resync, not the AI Coach prompt, not transactional
-- emails. As a buyer-visible optional input on the locations form
-- it was confusing dead UI ("paste your GBP URL").
--
-- If/when we integrate Google Places enrichment for the AI Coach,
-- the right primitive is a place_id, not a URL — re-add a typed
-- column then. No data preserved.

alter table client_locations
  drop column if exists gbp_url;
