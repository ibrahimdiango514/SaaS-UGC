-- Final additive form of the avatar provider check: all previously stored
-- values remain valid, new Reelora cards use `muapi`/`custom`/`legacy`, and no
-- retired provider name is hardcoded in the application or migration text.
alter table saas_ugc.ugc_avatars
  drop constraint if exists ugc_avatars_provider_check;
alter table saas_ugc.ugc_avatars
  add constraint ugc_avatars_provider_check
  check (provider ~ '^[a-z0-9_-]+$' and length(provider) between 2 and 40);
