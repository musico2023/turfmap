-- 0019_gbp_match_status.sql
--
-- Adds operator-confirmation tracking for Google Places matches.
--
-- The strict-match guardrail in lib/google/places.ts (distance < 100m
-- + Jaccard name similarity ≥ 0.5) is a basic auto-filter, but real-
-- world businesses sit in plazas + unit-numbered storefronts where
-- one address hosts many GBPs. The auto-match can still pick a
-- neighbor's listing. This column lets the operator confirm or
-- reject the match out-of-band, and lets us skip GBP signals in
-- the AI Coach for rejected/no-match locations.
--
-- Status values:
--   'auto'      — auto-matched, not yet reviewed by operator
--   'confirmed' — operator clicked confirm
--   'manual'    — operator searched and picked manually
--   'rejected'  — operator said this isn't us (place_id cleared)
--   'no_match'  — lookup ran, nothing matched (place_id null)
--
-- The AI Coach uses GBP signals when status IN ('auto', 'confirmed',
-- 'manual'). Status 'rejected' and 'no_match' suppress signals so
-- the Coach falls back to its prior generic recommendations.
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table client_locations
  add column if not exists google_place_match_status text;

-- Auditability — store the strict-match metrics so a wrong auto-match
-- is debuggable later without re-fetching from Google.
alter table client_locations
  add column if not exists google_place_match_distance_m integer;
alter table client_locations
  add column if not exists google_place_match_name_similarity numeric;

comment on column client_locations.google_place_match_status is
  'Operator-confirmation state for the auto-matched google_place_id. Values: auto / confirmed / manual / rejected / no_match. The AI Coach skips GBP signals when status IN (rejected, no_match).';
comment on column client_locations.google_place_match_distance_m is
  'Distance (meters) between geocoded coords and Google''s reported place location at match time. Audit trail for wrong auto-matches.';
comment on column client_locations.google_place_match_name_similarity is
  'Jaccard token similarity between submitted business name and Google''s displayName at match time. Audit trail.';

create index if not exists client_locations_match_status_idx
  on client_locations (google_place_match_status);
