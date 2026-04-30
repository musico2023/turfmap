-- Replace the (buggy) global UNIQUE(email) constraint on client_users with
-- the correct UNIQUE(client_id, email). The original constraint meant a
-- single email could only be on one client portal at a time, blocking:
--   * the agency owner from previewing multiple client portals
--   * a consultant who genuinely works with two of our clients
--
-- Apply via the Supabase SQL editor (this project isn't connected to MCP).
-- Safe to run multiple times — both branches use IF (NOT) EXISTS guards.

alter table client_users
  drop constraint if exists client_users_email_key;

create unique index if not exists client_users_client_email_unique
  on client_users (client_id, email);
