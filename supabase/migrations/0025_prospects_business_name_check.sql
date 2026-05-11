-- 0025_prospects_business_name_check.sql
--
-- DB-level guard against test/placeholder prefixes leaking into the
-- production prospects table.
--
-- Background: the cold-email lead-gen pipeline (Apify scraper +
-- enrichment + Cowork) inserts rows into prospects with business_name
-- sourced from Google Maps. During pipeline development + smoke tests,
-- test rows with prefixes like 'SMOKE TEST' got into the table; we
-- almost cold-emailed real prospects under fake business names.
-- A CHECK constraint at the DB level is the most robust guard —
-- prevents accidental insertions regardless of which client connects.
--
-- Conservative pattern list: only matches prefixes that no
-- legitimate home-services business would ever use. Case-insensitive
-- so 'smoke test plumbing' and 'SMOKE TEST PLUMBING' both fail.
-- Extend the list if new test patterns surface.

-- ─── 1. Clean up any existing rows that violate the new constraint ──
-- Pre-emptive delete so the constraint creation doesn't fail.
-- Only deletes rows matching the EXACT test prefixes — no risk of
-- removing legitimate businesses. The patterns are conservative.

delete from public.prospects
where business_name ilike 'SMOKE TEST%'
   or business_name ilike 'TEST_%'
   or business_name ilike '\\_TEST%' escape '\\';

-- ─── 2. Add the CHECK constraint ────────────────────────────────────
-- The constraint is named so it can be dropped/altered cleanly later
-- without juggling unnamed constraints.

alter table public.prospects
add constraint prospects_business_name_no_test_prefix
check (
  business_name not ilike 'SMOKE TEST%'
  and business_name not ilike 'TEST_%'
  and business_name not ilike '\\_TEST%' escape '\\'
);

-- ─── 3. Document the constraint ─────────────────────────────────────
-- PG comment so operators inspecting the table know why this is here
-- and how to update it.

comment on constraint prospects_business_name_no_test_prefix on public.prospects is
  'Rejects rows with obvious test prefixes (SMOKE TEST*, TEST_*, _TEST*). '
  'Belt-and-braces guard for the cold-email outbound pipeline. '
  'Extend the IN clause if new test patterns surface during smoke tests.';
