-- 0037_clients_preview_state.sql
--
-- Add clients.is_preview to power the /score lead-magnet funnel.
--
-- A "preview" client is created when a public visitor uses the
-- /score flow to get a free TurfScore. The 81-point DFS scan runs
-- and the share link is created, but everything is rendered in
-- preview mode (blurred heatmap, hidden AI Coach, locked competitor
-- table) until the buyer pays $99 to unlock.
--
-- On unlock (Stripe checkout.session.completed with
-- metadata.source='score_unlock'), is_preview flips to false and the
-- record becomes indistinguishable from a normal paid TurfScan
-- buyer — AI Coach generates, portal access provisions, lead_orders
-- row inserts, operator Slack fires.
--
-- Why on `clients` (not on `scan_share_links`): preview-ness is a
-- property of the buyer, not the share. Operator dashboards,
-- weekly-scan cron, lead-order counts, and the P&L view all need
-- to filter out previews — keeping the flag on `clients` makes it
-- a single `AND is_preview = false` everywhere.

alter table public.clients
  add column is_preview boolean not null default false;

-- Partial index for the hot path: every operator query reads only
-- non-preview clients. Partial index keeps the lookup fast without
-- bloating storage with preview rows that get GC'd at 30 days.
create index clients_active_only_idx on public.clients (id)
  where is_preview = false;

comment on column public.clients.is_preview is
  'True when this client was created via the /score lead-magnet '
  'preview flow (not a paid scan). Filtered out of operator '
  'dashboards, weekly cron scans, and P&L. Flipped to false when '
  'the buyer pays the $99 unlock via the score_unlock Stripe '
  'Checkout flow.';
