-- Score redesign: replaces the AMR-based TurfScore with the composite
-- (TurfReach × TurfRank) family. Adds two new columns and starts a
-- soft-deprecation of two existing ones.
--
-- Apply via the Supabase SQL editor (this project isn't connected to
-- MCP). Safe to re-run — every change is guarded with IF NOT EXISTS.
--
-- After applying:
--   1. Run `npx tsx scripts/backfill-new-scores.ts` to repopulate
--      turf_score, turf_reach, turf_rank, momentum on every existing
--      complete scan from scan_points data.
--   2. Verify expected values for Kidcrew, Logik, Ivy's Touch
--      (the script prints them).
--
-- Columns this migration affects:
--
--   ADD scans.turf_reach   (integer 0..100, was top3_win_rate)
--   ADD scans.turf_rank    (numeric 0..3, new)
--   ADD scans.momentum     (integer, signed delta vs. prior scan)
--   KEEP scans.turf_score  (column reused; semantics change from AMR
--                          1..20 to composite 0..100 — backfill will
--                          rewrite every row)
--   DEPRECATE scans.top3_win_rate     (kept for historical safety;
--                                      readers should switch to
--                                      turf_reach. Drop in a later
--                                      cleanup migration.)
--   DEPRECATE scans.turf_radius_units (kept for historical safety;
--                                      no longer populated on new
--                                      scans. Drop in a later cleanup.)

alter table scans add column if not exists turf_reach integer;
alter table scans add column if not exists turf_rank numeric;
alter table scans add column if not exists momentum integer;

comment on column scans.turf_reach is
  'Coverage 0-100. % of grid cells where the business is in the local 3-pack. Replaces top3_win_rate.';
comment on column scans.turf_rank is
  'Rank quality 0-3. 4 minus avg rank across cells where the business appears. NULL when no presence.';
comment on column scans.momentum is
  'Signed integer delta of turf_score vs. the previous scan for this client. NULL on first scan.';
comment on column scans.turf_score is
  'Composite 0-100. turf_reach × (turf_rank / 3). Replaced AMR semantics on 2026-05-02.';
comment on column scans.top3_win_rate is
  'DEPRECATED 2026-05-02. Replaced by turf_reach. Kept for historical safety; do not write to it on new scans.';
comment on column scans.turf_radius_units is
  'DEPRECATED 2026-05-02. Max-reach metric retired; turf_reach + turf_rank carry the relevant signal. Kept for historical safety; do not write to it on new scans.';
