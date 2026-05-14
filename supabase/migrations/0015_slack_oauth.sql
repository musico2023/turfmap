-- 0015_slack_oauth.sql
--
-- Adds display metadata for the Slack incoming-webhook OAuth flow.
-- The webhook URL itself already lives on clients.slack_webhook_url
-- (added in migration 0013); this migration just adds two columns so
-- the AlertPrefsCard can render "Connected to Acme Corp #alerts"
-- instead of just a generic "Slack connected" pill.
--
-- Both nullable. Set together by /api/integrations/slack/callback at
-- the end of an OAuth flow. Cleared together by
-- /api/integrations/slack/disconnect.
--
-- We do NOT store the bot token — the incoming-webhook scope returns
-- a per-channel webhook URL that's the only credential we need. No
-- token rotation or refresh handling required, which is the whole
-- reason we picked this scope over chat:write.

alter table clients
  add column if not exists slack_team_name text,
  add column if not exists slack_channel_name text;
