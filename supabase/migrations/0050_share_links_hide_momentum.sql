-- Per-share-link momentum suppression.
--
-- The share page renders MomentumCard whenever scans.momentum is non-null.
-- That's right for a recurring client report, but wrong for a one-off sales
-- share: momentum compares against the PREVIOUS scan, and when the previous
-- scan is an unrepresentative baseline the delta reads as a claim the
-- operator doesn't want to make. Suppressing it per-link keeps the
-- underlying scan data intact (momentum stays on the dashboard, the portal
-- and the PDF) instead of nulling a real measurement to change one page.
alter table scan_share_links
  add column if not exists hide_momentum boolean not null default false;

comment on column scan_share_links.hide_momentum is
  'When true, /share/<id> omits the Momentum card. Presentation-only; does not alter scans.momentum.';
