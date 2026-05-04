-- Per-location keyword uniqueness.
--
-- Pre-0010 the unique constraint on tracked_keywords was
-- (client_id, keyword) — global per client. Pre-multi-location that
-- made sense; post-migration 0006 (multi-location-aware scans), it's
-- a bug: a multi-location client (e.g. Kidcrew with Midtown + North
-- York) can't track the same keyword on both locations to compare
-- their independent local-pack visibility, even though that's
-- exactly what TurfMap is built for.
--
-- New constraint: (client_id, location_id, keyword). Same keyword
-- can exist on different locations of the same client. Within a
-- single location, the keyword is still unique.
--
-- Apply via the Supabase SQL editor. Idempotent — uses
-- introspection to find any existing client_id+keyword unique and
-- drops it by name regardless of how it was originally generated.
-- Safe to re-run.

-- 1. Drop any existing (client_id, keyword) unique constraint by
--    finding it via pg_constraint introspection. Standard Postgres
--    auto-names this `tracked_keywords_client_id_keyword_key` but we
--    don't hardcode the name in case it was renamed.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'tracked_keywords'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) ilike '%(client_id, keyword)%'
  limit 1;

  if cname is not null then
    execute 'alter table tracked_keywords drop constraint ' || quote_ident(cname);
    raise notice 'dropped constraint %', cname;
  end if;
end$$;

-- 2. Add the new per-location uniqueness. NULL location_id slots
--    don't constrain each other (Postgres NULL semantics for unique)
--    — fine, since migration 0006 backfilled location_id on every
--    existing row and the API requires it for new inserts.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tracked_keywords_client_id_location_id_keyword_key'
  ) then
    alter table tracked_keywords
      add constraint tracked_keywords_client_id_location_id_keyword_key
      unique (client_id, location_id, keyword);
  end if;
end$$;
