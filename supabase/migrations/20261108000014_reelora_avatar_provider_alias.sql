-- Reelora Studio — additive avatar provider aliases.
-- Existing values are preserved (no row update/delete). The UI no longer
-- exposes retired provider names; MuAPI reference cards use `muapi`, and old
-- records are shown as `legacy` without any provider integration.

alter table saas_ugc.ugc_avatars
  drop constraint if exists ugc_avatars_provider_check;
alter table saas_ugc.ugc_avatars
  add constraint ugc_avatars_provider_check
  check (provider ~ '^[a-z0-9_-]+$' and length(provider) between 2 and 40);
