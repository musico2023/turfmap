-- 0016_pending_buyer_email.sql
--
-- Adds clients.pending_buyer_email — the email address the operator
-- enters at create time when picking a Stripe plan (Pulse / Pulse+)
-- on the agency-side ClientCreateForm.
--
-- We need this column because:
--   1. The Stripe Checkout link can be regenerated later (24h Stripe
--      default expiry, or buyer abandonment) — the regenerate flow
--      needs to know who to address the email to without making the
--      operator re-enter it.
--   2. The auto-email of the initial Checkout link uses this address.
--   3. Pre-Checkout there's no Stripe customer object to read the
--      email back from, so we have to persist it ourselves.
--
-- Naming: "pending_" prefix because once the buyer completes Checkout,
-- Stripe creates a Customer with the same email. From that point
-- on, Stripe is the source of truth for the buyer email and
-- pending_buyer_email is mostly historical — we leave it set
-- (audit trail) but read from Stripe's customer.email going forward.

alter table clients
  add column if not exists pending_buyer_email text;
