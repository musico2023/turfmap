-- 0020_onboarding_wizard.sql
--
-- Adds clients.onboarding_step — drives the post-checkout onboarding
-- wizard for self-serve subscription buyers (Pulse / Pulse+).
--
-- Lifecycle:
--   - Set to 'gbp_match' by /api/orders/fulfill when a Pulse / Pulse+
--     order completes (i.e., billing_mode = 'self_serve_subscription').
--   - Updated by the buyer as they advance through wizard steps via
--     /api/onboarding/[publicId] (auth: stripe_session_id ↔ lead_orders).
--   - Set to 'done' when the buyer reaches the final step (or skips
--     past the last actionable step).
--   - NULL for clients not in a wizard flow:
--       * Existing clients pre-migration
--       * Agency-managed clients (operator already configured them)
--       * One-time tiers (Audit / Strategy / Scan — those use the
--         Cal.com flow on the success state instead).
--
-- Steps:
--   gbp_match     — confirm or correct the auto-matched GBP listing
--   portal_users  — invite teammates (skippable)
--   competitors   — add up to 3 competitors to track (Pulse+ only,
--                    skippable; Pulse skips this step entirely)
--   done          — wizard complete; portal CTA shown
--
-- Apply via the Supabase SQL editor. Safe to re-run.

alter table clients
  add column if not exists onboarding_step text;

comment on column clients.onboarding_step is
  'Post-checkout onboarding wizard state for self-serve subscription buyers. Values: gbp_match / portal_users / competitors / done. NULL for agency-managed, one-time tiers, or pre-migration clients.';

create index if not exists clients_onboarding_step_idx
  on clients (onboarding_step)
  where onboarding_step is not null and onboarding_step <> 'done';
