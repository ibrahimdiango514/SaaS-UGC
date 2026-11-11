-- First-admin bootstrap is intentionally unavailable to browser roles.
-- The project owner runs this once from the Supabase SQL editor after signup
-- and email confirmation. It refuses to run once any admin already exists.
create or replace function public.reelora_bootstrap_first_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if nullif(btrim(p_email), '') is null then
    raise exception 'admin_bootstrap_email_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reelora_first_admin_bootstrap', 0)
  );

  if exists (
    select 1
      from saas_ugc.ugc_user_roles
     where role = 'admin'
  ) then
    raise exception 'admin_already_bootstrapped';
  end if;

  select u.id
    into v_user_id
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
     and u.email_confirmed_at is not null
   for update;

  if v_user_id is null then
    raise exception 'confirmed_auth_user_not_found';
  end if;

  insert into saas_ugc.ugc_user_roles(user_id, role)
  values (v_user_id, 'admin')
  on conflict (user_id, role) do nothing;

  return v_user_id;
end;
$$;

revoke all on function public.reelora_bootstrap_first_admin(text) from public, anon, authenticated;
grant execute on function public.reelora_bootstrap_first_admin(text) to postgres, service_role;

notify pgrst, 'reload schema';
