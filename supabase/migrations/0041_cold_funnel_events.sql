-- 0041_cold_funnel_events.sql
--
-- Cold-email funnel instrumentation. Single typed table that
-- captures every measurable site-side event in the cold-email →
-- /yourmap → free TurfScan funnel, keyed by prospect_id and the
-- campaign UTMs the email URL embedded. Powers the
-- cold_funnel_summary view (joined with prospects + ops_lander_visits
-- in a separate migration) and the /admin/cold-funnel page.
--
-- Why a NEW table instead of extending ops_lander_visits:
--   ops_lander_visits is purposely scoped to one event (page load).
--   Conflating "scroll milestone" / "CTA click" / "scan completed"
--   into the same row dilutes its semantics + makes queries that
--   ask "how many people viewed?" require additional WHERE clauses.
--   A typed event_type column on a separate table keeps each event's
--   semantics clean.
--
-- Event vocabulary (CHECK constraint enforces the closed set so a
-- typo can't silently land a bogus row):
--   'yourmap_view'         — page load (covers Section 4 step 5,
--                            same signal ops_lander_visits already
--                            tracks; we log to both for now so the
--                            cold_funnel_summary view doesn't need
--                            to JOIN cross-table)
--   'yourmap_scroll_50'    — hit 50% of viewport scroll
--   'yourmap_scroll_form'  — the CTA section came into view
--   'coldscan_cta_click'   — clicked "Run my free TurfScan" button
--   'free_scan_started'    — /api/score/preview-init received the
--                            submit and started the 81-point scan
--   'free_scan_completed'  — /share/<id> render succeeded for a
--                            cold-cohort prospect
--
-- The pipeline is intentionally append-only — no UPDATE statements.
-- Re-firing the same event for the same prospect is fine; the view
-- COUNTs DISTINCT prospect_id per event_type so duplicates don't
-- inflate funnel rates.
--
-- Bot filtering: the funnelEvents.ts helper applies the same
-- SCANNER_UA_PATTERNS regex set landerVisits.ts uses (Microsoft
-- SafeLinks, Proofpoint, Mimecast, social-card unfurlers, generic
-- HTTP clients). Inserts happen via service-role; RLS denies anon.

create table if not exists public.cold_funnel_events (
  id bigserial primary key,

  -- Discrete funnel step. Closed vocabulary; see CHECK constraint.
  event_type text not null,

  -- Prospect this event belongs to. Nullable for the rare case where
  -- a /yourmap view arrives without a resolvable prospect_id (the
  -- visitor stripped the param or typo'd it); we still log the view
  -- so the "broken-link" rate is measurable, just without prospect
  -- attribution.
  prospect_id text references public.prospects(id) on delete cascade,

  -- Campaign + source attribution stamped at lead-gen time and
  -- embedded in the email URL. utm_campaign is the primary slice
  -- (e.g. 'roofing_orlando_q2_2026'). utm_source/medium typically
  -- 'cold_email' / 'outbound' for this channel but persisted so
  -- the same table can host future channels.
  utm_source text,
  utm_medium text,
  utm_campaign text,

  -- Forensic fields. user_agent feeds the scanner-bot filter at
  -- INSERT time (server-side), so anything that lands here is
  -- already filtered. referer is useful when debugging
  -- traffic-source attribution.
  user_agent text,
  referer text,

  created_at timestamptz not null default now()
);

alter table public.cold_funnel_events
  add constraint cold_funnel_events_event_type_check
  check (
    event_type = any (array[
      'yourmap_view',
      'yourmap_scroll_50',
      'yourmap_scroll_form',
      'coldscan_cta_click',
      'free_scan_started',
      'free_scan_completed'
    ]::text[])
  );

-- Per-campaign queries hit the table hard. utm_campaign is the
-- primary slice; created_at supports time-range filters in the
-- dashboard. Partial index on prospect_id-not-null keeps the
-- "view but no scan" lookups cheap.
create index if not exists cold_funnel_events_campaign_idx
  on public.cold_funnel_events (utm_campaign);

create index if not exists cold_funnel_events_event_type_created_idx
  on public.cold_funnel_events (event_type, created_at desc);

create index if not exists cold_funnel_events_prospect_idx
  on public.cold_funnel_events (prospect_id)
  where prospect_id is not null;

comment on table public.cold_funnel_events is
  'Append-only funnel events for the cold-email → /yourmap → free-scan flow. Powers cold_funnel_summary view + /admin/cold-funnel. See migration 0041.';

comment on column public.cold_funnel_events.event_type is
  'Funnel step. Closed vocabulary enforced by CHECK constraint. See migration 0041 for the canonical list.';

-- ─── RLS ──────────────────────────────────────────────────────────────
--
-- Service-role-only. Same posture as prospects + ops_lander_visits —
-- the funnelEvents.ts helper writes via the server's service-role
-- client. Anon reads would expose campaign performance + per-prospect
-- behavior to anyone with a Supabase anon key, which we don't want.

alter table public.cold_funnel_events enable row level security;
