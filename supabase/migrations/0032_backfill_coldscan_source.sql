-- 0032_backfill_coldscan_source.sql
--
-- One-off backfill: stamp `stripe_metadata.source = 'coldscan_free'`
-- on legacy cold-cohort lead_orders that came through pre-COLDSCAN-
-- bypass paths.
--
-- ─── Background ────────────────────────────────────────────────────
-- The /api/yourmap/coldscan-fulfill route (introduced by migration
-- 0031) consistently stamps `source: 'coldscan_free'` on the
-- lead_orders it creates. Earlier cold-email cohorts came through
-- /api/checkout/[tier] with a 100%-off coupon — same conversion
-- semantically (cold prospect, $0 charge, prospect_id stamped) but
-- the metadata schema didn't include the `source` discriminator.
--
-- This left ~N legacy lead_orders where:
--   - cohort = 'cold_email' (or 'cold_email_q2_2026')
--   - prospect_id is stamped
--   - source IS NULL
--   - amount_total = 0 (paid $0 via VIP / COLDSCAN coupon)
--
-- Yohann Jacob at Ainger Group Roofing was the catalyst: he hit the
-- audit Cal.com link after this kind of lead_order, the bootstrap
-- failed to find his client because the resolver assumed
-- source='coldscan_free' was always present, and the /share/[id]
-- page would have rendered the conversion-CTA footer (suppressed for
-- cold cohort) for him.
--
-- The application code is now source-agnostic — it ORs together
-- source / cohort / prospect_id signals to detect cold-cohort buyers.
-- This migration backfills the data so legacy and new lead_orders
-- have consistent metadata going forward, AND so any future code
-- that wants to use `source = 'coldscan_free'` as a simple filter
-- gets the historical buyers too.
--
-- ─── Idempotency ──────────────────────────────────────────────────
-- The WHERE clause requires source IS NULL, so re-running this
-- migration after it's already applied is a no-op. Safe to keep in
-- the migration history.
--
-- ─── Discriminator ────────────────────────────────────────────────
-- Cohort-based gate (cohort LIKE 'cold_email%') is the primary
-- signal — those are unambiguously cold-outreach buyers. Excludes:
--   - VIP /freescan warm-reactivation cohort (cohort='crm_reactivation_q2')
--   - Organic paid scans (no cohort stamp)
--   - Audit-upgrade lead_orders (audit/strategy tier, different shape)
--
-- We do NOT use prospect_id presence alone as the discriminator
-- because some warm-cohort paths also stamp prospect_id with a
-- different semantic meaning.

UPDATE lead_orders
SET stripe_metadata = jsonb_set(
  COALESCE(stripe_metadata, '{}'::jsonb),
  ARRAY['source'],
  '"coldscan_free"'::jsonb,
  true  -- create_missing: yes, this is what we want
)
WHERE (stripe_metadata->>'source') IS NULL
  AND (stripe_metadata->>'cohort') LIKE 'cold_email%';

-- Diagnostic comment on the run (visible in `supabase migration list`
-- output via the migration's docstring above).
COMMENT ON COLUMN lead_orders.stripe_metadata IS
  'JSONB blob of cohort/utm/intake fields stamped at lead_order creation. The "source" field discriminates the buyer-acquisition path: "coldscan_free" (cold-email outreach, $0), "scan_intake" (intake-first paid checkout), "audit_upgrade" (1-click upgrade from scan), null (legacy paid path). Backfilled to coldscan_free for cohort=cold_email* lead_orders by migration 0032.';
