-- 0011_backfill_orphan_keyword_locations.sql
--
-- Backfill tracked_keywords.location_id for rows that ended up with
-- location_id = NULL. Two cohorts hit this state:
--
--   1) Pre-migration 0010 keywords (when the column didn't exist yet).
--   2) Post-0010 keywords inserted by the client-create endpoint, which
--      forgot to stamp location_id on the primary keyword. That bug is
--      fixed in app/api/clients/route.ts going forward; this migration
--      cleans up the rows already in the database.
--
-- Strategy: for each NULL row, attach the client's primary location.
-- Every client has exactly one primary (is_primary = true) per the
-- client_locations layout introduced in 0006, so there's no ambiguity.
-- Falls back to ANY location for the client if no primary is flagged
-- (defensive — shouldn't happen but better than leaving the row orphan).
--
-- Idempotent: only updates rows where location_id is currently null,
-- so re-running is a no-op.

update tracked_keywords kw
set location_id = coalesce(
  (select id from client_locations
    where client_id = kw.client_id and is_primary = true
    limit 1),
  (select id from client_locations
    where client_id = kw.client_id
    order by created_at asc
    limit 1)
)
where location_id is null;
