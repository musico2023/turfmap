-- 0028_nap_audits_provider.sql
--
-- Add a `provider` column to nap_audits so we know which backend
-- generated each audit's findings. Two providers as of v1:
--
--   'brightlocal' — BL Data API. Higher accuracy (structured NAP per
--                   directory), but trial-capped at 250 reqs and gated
--                   commercially at $500/mo / 10k req volume floor.
--                   Reserved for high-value manual sales-call audits.
--
--   'dfs'         — DataForSEO Google SERP scrape with site: filters.
--                   ~$0.09 per audit at ~9 directories. Lower accuracy
--                   (snippet-derived NAP), but works for ALL buyer
--                   tiers. Default for new audits.
--
-- Backfill rule: existing audits all came from BrightLocal (the
-- pre-DFS-checker era), so set 'brightlocal' for any row where the
-- column is NULL after the ALTER. CHECK constraint validates new
-- writes against the known-provider list.
--
-- Safe to re-run: column add is IF NOT EXISTS, constraint drop is
-- guarded by a DO block.

-- ─── 1. Column ──────────────────────────────────────────────────────
alter table public.nap_audits
  add column if not exists provider text;

-- ─── 2. Backfill ────────────────────────────────────────────────────
update public.nap_audits
  set provider = 'brightlocal'
  where provider is null;

-- ─── 3. CHECK constraint ────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'nap_audits_provider_check'
  ) then
    alter table public.nap_audits drop constraint nap_audits_provider_check;
  end if;
  alter table public.nap_audits
    add constraint nap_audits_provider_check
    check (provider in ('brightlocal', 'dfs'));
end$$;

-- ─── 4. Document ────────────────────────────────────────────────────
comment on column public.nap_audits.provider is
  'Which backend generated this audit. brightlocal = BL Data API '
  '(higher accuracy, trial/commercial-capped, reserved for paid '
  'tiers and manual one-offs); dfs = DataForSEO SERP scrape '
  '(lower accuracy, ~$0.09/audit, default for all tiers since '
  'commit 850a51b is reverted).';
