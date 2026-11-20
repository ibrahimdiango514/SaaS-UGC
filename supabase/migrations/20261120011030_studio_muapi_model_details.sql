-- Production additive catalog detail preparation: never infer integration or account access.
create table if not exists saas_ugc.studio_ai_model_details (
  model_id uuid primary key references saas_ugc.studio_ai_models(id),
  status text not null check (status in ('ok','http_error','invalid','network_error')),
  checked_at timestamptz not null default now(),
  http_status integer,
  constraint studio_detail_http_status check (http_status is null or http_status between 100 and 599)
);
alter table saas_ugc.studio_ai_model_details enable row level security;
revoke all on saas_ugc.studio_ai_model_details from public, anon, authenticated;

create or replace function public.studio_muapi_detail_candidates(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then raise exception 'invalid_limit'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q)) from (
    select m.provider_model_id from saas_ugc.studio_ai_models m
    left join saas_ugc.studio_ai_model_details d on d.model_id=m.id
    where m.provider_key='muapi' and m.public_catalog_present
    order by d.checked_at asc nulls first, m.provider_model_id
    limit p_limit
  ) q), '[]'::jsonb);
end $$;
revoke all on function public.studio_muapi_detail_candidates(integer) from public, anon, authenticated;
grant execute on function public.studio_muapi_detail_candidates(integer) to service_role;

create or replace function public.studio_save_muapi_detail(
  p_model_id text, p_status text, p_http_status integer, p_input_schema jsonb, p_output_schema jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_status is null or p_status not in ('ok','http_error','invalid','network_error') then raise exception 'invalid_status'; end if;
  if p_status='ok' and (jsonb_typeof(p_input_schema) is distinct from 'object'
    or (p_output_schema is not null and jsonb_typeof(p_output_schema) is distinct from 'object')) then raise exception 'invalid_schema'; end if;
  select id into v_id from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id and public_catalog_present for update;
  if v_id is null then return false; end if;
  if p_status='ok' then
    update saas_ugc.studio_ai_models set input_schema=p_input_schema,
      output_schema=coalesce(p_output_schema,output_schema), updated_at=now() where id=v_id;
  end if;
  insert into saas_ugc.studio_ai_model_details(model_id,status,http_status,checked_at)
    values(v_id,p_status,p_http_status,now())
    on conflict(model_id) do update set status=excluded.status,http_status=excluded.http_status,checked_at=excluded.checked_at;
  return true;
end $$;
revoke all on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb) to service_role;
