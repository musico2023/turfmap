-- 0046 — prospects lost-revenue estimate (v2.2 §P0.1)
--
-- Adds four columns to prospects to store the per-prospect monthly
-- lost-revenue estimate produced by lib/lost_rev.py in the Lead Gen
-- repo. Populated at row-build time by the daily pipeline; read at
-- render time by /yourmap for the dollar-headline block and by
-- Instantly cold-email templates for {{lost_rev_display}} merge.
--
-- Columns:
--   lost_rev_low         numeric   floor of monthly-lost-revenue range (CAD)
--   lost_rev_high        numeric   ceiling of range (CAD)
--   lost_rev_display     text      pre-rounded pretty range, e.g. "$3,100 – $5,800/mo"
--   lost_rev_confidence  text      "high" | "medium" | "low" — /yourmap
--                                  should render "estimated" more prominently
--                                  when this is "low"
--
-- Backward-compat: all four are nullable so pre-2026-07-01 rows continue
-- to render without a value; the /yourmap dollar-headline block falls
-- back to the invisibility-count sentence when lost_rev_display is null.
--
-- Not indexed: these fields are read via prospect_id lookup, never
-- filtered on. Adding indexes would waste write throughput on the
-- daily pipeline for no benefit.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS lost_rev_low        numeric,
  ADD COLUMN IF NOT EXISTS lost_rev_high       numeric,
  ADD COLUMN IF NOT EXISTS lost_rev_display    text,
  ADD COLUMN IF NOT EXISTS lost_rev_confidence text;

COMMENT ON COLUMN prospects.lost_rev_low
  IS 'Monthly-lost-revenue floor (CAD). Formula in lib/lost_rev.py.';
COMMENT ON COLUMN prospects.lost_rev_high
  IS 'Monthly-lost-revenue ceiling (CAD). Formula in lib/lost_rev.py.';
COMMENT ON COLUMN prospects.lost_rev_display
  IS 'Pre-rounded display range for /yourmap + email merges, e.g. "$3,100 – $5,800/mo".';
COMMENT ON COLUMN prospects.lost_rev_confidence
  IS 'high|medium|low. Downgraded automatically when monthly_searches falls back to per-trade default.';
