create or replace function public.reelora_first_admin_bootstrap_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from saas_ugc.ugc_user_roles
     where role = 'admin'
  );
$$;

revoke all on function public.reelora_first_admin_bootstrap_available() from public;
grant execute on function public.reelora_first_admin_bootstrap_available() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
