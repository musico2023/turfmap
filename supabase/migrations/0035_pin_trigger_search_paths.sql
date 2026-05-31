-- 0035_pin_trigger_search_paths.sql
--
-- Pin search_path on the two `set updated_at = now()` trigger functions
-- so they're immune to search_path-injection attacks.
--
-- Both functions reference `now()` unqualified, which means at execution
-- time Postgres resolves it via the session's search_path. If an
-- attacker could create a malicious schema higher in search_path
-- containing their own `now()`, the trigger would invoke that
-- instead of pg_catalog.now() on every INSERT / UPDATE.
--
-- The attack vector is narrow:
--   - Both functions are SECURITY INVOKER (run with caller's perms),
--     so the worst an attacker could do is poison their own data.
--   - The tables they're attached to (lead_orders, visibility_audits)
--     are RLS-on with no policies — only the service-role client can
--     write to them, and service-role's search_path is controlled.
--
-- So the real risk is low, but the supabase advisor lints this with
-- `function_search_path_mutable` and the fix is one ALTER per
-- function. Hygiene + clears the advisor flag.
--
-- search_path = public, pg_temp pins the resolution to:
--   1. public schema (where our app schema lives)
--   2. pg_temp (per-session temp tables, standard last entry)
--
-- pg_catalog is implicitly first regardless of search_path, so `now()`
-- always resolves to pg_catalog.now() even though it's not listed.

alter function public.lead_orders_set_updated_at()
  set search_path = public, pg_temp;

alter function public.visibility_audits_set_updated_at()
  set search_path = public, pg_temp;
