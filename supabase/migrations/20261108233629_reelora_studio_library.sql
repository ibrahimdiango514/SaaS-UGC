-- Reelora Studio — additive library helpers.
-- Allows an authenticated workspace editor to attach an existing generated
-- asset to one of the workspace's projects. RLS stays enabled; no table, view,
-- policy or data is removed and no second credit architecture is introduced.

create or replace function public.reelora_attach_asset_to_project(
  p_asset_id uuid,
  p_project_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_asset_ws uuid;
  v_project_ws uuid;
begin
  perform ugc_private.reelora_assert_active();
  if v_uid is null then raise exception 'forbidden'; end if;

  select a.workspace_id into v_asset_ws
    from saas_ugc.ugc_generated_assets a
   where a.id = p_asset_id;
  if v_asset_ws is null or not ugc_private.can_edit_workspace(v_asset_ws) then
    raise exception 'forbidden';
  end if;

  select p.workspace_id into v_project_ws
    from saas_ugc.ugc_video_projects p
   where p.id = p_project_id;
  if v_project_ws is null or v_project_ws <> v_asset_ws
     or not ugc_private.can_edit_workspace(v_project_ws) then
    raise exception 'forbidden';
  end if;

  update saas_ugc.ugc_generated_assets
     set project_id = p_project_id
   where id = p_asset_id and workspace_id = v_asset_ws;
  return found;
end $$;

revoke all on function public.reelora_attach_asset_to_project(uuid, uuid) from public, anon;
grant execute on function public.reelora_attach_asset_to_project(uuid, uuid) to authenticated;
