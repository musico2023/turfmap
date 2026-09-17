-- Per-share-link AI Coach suppression.
--
-- Same shape and reasoning as 0050's hide_momentum. The Coach's stored
-- recommendations (ai_insights) are keyed by scan and shared with the
-- dashboard, portal and PDF. When a scan's Coach output is known to be
-- wrong — e.g. built on a citation audit the DFS checker has since fixed,
-- or advice a franchisee can't execute — the operator needs to send a
-- clean share link without deleting the stored insight everywhere.
alter table scan_share_links
  add column if not exists hide_ai_coach boolean not null default false;

comment on column scan_share_links.hide_ai_coach is
  'When true, /share/<id> omits the AI Coach panel. Presentation-only; does not alter ai_insights.';
