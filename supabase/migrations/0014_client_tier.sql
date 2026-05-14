-- 0014_client_tier.sql
--
-- Adds clients.tier — explicit per-client subscription-tier column.
-- Drives the agency dashboard's tier toggle, the portal page's
-- billing panel, and the per-feature gating for Pulse+-only
-- surfaces (citations, exports, granular alerts).
--
-- Why a column instead of resolving from Stripe at read time:
--   - Read-fast: the dashboard reads tier on every render to gate
--     feature visibility. Hitting Stripe per render is too slow.
--   - Override capability: operators need to flip tier manually for
--     demo accounts, agency-managed clients, or recovery scenarios
--     where the Stripe webhook hasn't fired yet.
--   - Single source of truth in DB is simpler than mirror-on-read.
--
-- The Stripe webhook (TODO, item 2 in the original roadmap) will
-- write to this column on customer.subscription.created/updated
-- events. Until then, operators set it via the override endpoint.
--
-- Nullable because one_time clients (TurfScan / Audit / Strategy
-- buyers) don't have a recurring tier — they bought a one-shot
-- product. The agency dashboard hides recurring-tier UI for those.
--
-- Backfill: existing self_serve_subscription clients are unknown —
-- assume Pulse+ (the operator can flip to Pulse via the override
-- card if needed). agency_managed clients similarly default to
-- Pulse+ since the agency-contract value bundle includes
-- everything. one_time clients stay NULL.

alter table clients
  add column if not exists tier text
    check (tier in ('pulse', 'pulse_plus'));

-- Backfill recurring-tier clients to Pulse+ (the more permissive
-- default — operators can flip down to Pulse manually for clients
-- on the lower tier). one_time stays NULL.
update clients
set tier = 'pulse_plus'
where tier is null
  and billing_mode in ('agency_managed', 'self_serve_subscription');

create index if not exists idx_clients_tier on clients(tier)
  where tier is not null;
