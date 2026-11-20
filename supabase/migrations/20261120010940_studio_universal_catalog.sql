-- Registre Studio séparé de Business Grow et du catalogue vidéo existant.
-- Migration additive : aucun abonnement, crédit ou modèle existant modifié.
-- A appliquer uniquement après validation ; aucune donnée fournisseur n'est chargée ici.
create table if not exists saas_ugc.studio_ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null check (provider_key ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_model_id text not null check (length(provider_model_id) between 1 and 160),
  display_name text not null,
  category text not null,
  description text,
  input_fields jsonb not null default '[]'::jsonb,
  required_fields jsonb not null default '[]'::jsonb,
  input_schema jsonb,
  output_schema jsonb,
  metadata jsonb not null default '{}'::jsonb,
  provider_enabled boolean,
  coming_soon boolean,
  public_catalog_present boolean not null default true,
  account_access text not null default 'unverified' check (account_access in ('unverified', 'available', 'unavailable')),
  integration_status text not null default 'catalog_only' check (integration_status in ('catalog_only', 'partial', 'integrated', 'e2e_verified')),
  studio_enabled boolean not null default false,
  adapter_key text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, provider_model_id)
);
create index if not exists studio_ai_models_category_idx on saas_ugc.studio_ai_models(provider_key, category);
create table if not exists saas_ugc.studio_ai_catalog_syncs (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null,
  source_scope text not null,
  model_count integer not null,
  synced_at timestamptz not null default now()
);
create table if not exists saas_ugc.studio_ai_catalog_changes (
  id bigint generated always as identity primary key,
  sync_id uuid not null references saas_ugc.studio_ai_catalog_syncs(id),
  model_id uuid not null references saas_ugc.studio_ai_models(id),
  change_type text not null check (change_type in ('added', 'changed', 'missing', 'reappeared')),
  before_metadata jsonb,
  after_metadata jsonb,
  created_at timestamptz not null default now()
);
-- Catalog contents and supplier metadata are never directly readable by clients.
alter table saas_ugc.studio_ai_models enable row level security;
alter table saas_ugc.studio_ai_catalog_syncs enable row level security;
alter table saas_ugc.studio_ai_catalog_changes enable row level security;
revoke all on saas_ugc.studio_ai_models, saas_ugc.studio_ai_catalog_syncs, saas_ugc.studio_ai_catalog_changes from public, anon, authenticated;

-- Service-only transaction. The Edge Function authorizes the administrator
-- before fetching, validates all pages, and submits a complete public snapshot.
create or replace function public.studio_sync_muapi_catalog(p_models jsonb, p_scope text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sync uuid;
  v_item jsonb;
  v_old saas_ugc.studio_ai_models%rowtype;
  v_id uuid;
  v_changed integer := 0;
  v_added integer := 0;
  v_missing integer := 0;
  v_count integer;
  v_previous_count integer;
  v_before jsonb;
  v_after jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_scope is distinct from 'public' or jsonb_typeof(p_models) is distinct from 'array' then raise exception 'invalid_snapshot'; end if;
  v_count := jsonb_array_length(p_models);
  if v_count < 1 or v_count > 50000 then raise exception 'invalid_snapshot_size'; end if;
  if exists (select 1 from jsonb_array_elements(p_models) x
             where jsonb_typeof(x) <> 'object' or coalesce(x->>'provider_model_id','') !~ '^[A-Za-z0-9._~-]{1,160}$'
                or jsonb_typeof(x->'input_fields') <> 'array' or jsonb_typeof(x->'required_fields') <> 'array')
     or (select count(distinct x->>'provider_model_id') from jsonb_array_elements(p_models) x) <> v_count
  then raise exception 'invalid_snapshot_models'; end if;
  perform pg_advisory_xact_lock(hashtext('studio_sync_muapi_catalog'));
  select count(*) into v_previous_count from saas_ugc.studio_ai_models
    where provider_key='muapi' and public_catalog_present;
  -- A dramatic upstream shrink might be an incomplete response despite its total.
  if v_previous_count >= 20 and v_count < v_previous_count / 2 then
    raise exception 'snapshot_suspiciously_small';
  end if;
  insert into saas_ugc.studio_ai_catalog_syncs(provider_key, source_scope, model_count)
    values ('muapi', p_scope, v_count) returning id into v_sync;
  for v_item in select value from jsonb_array_elements(p_models) loop
    select * into v_old from saas_ugc.studio_ai_models
      where provider_key='muapi' and provider_model_id=v_item->>'provider_model_id' for update;
    if not found then
      insert into saas_ugc.studio_ai_models(provider_key, provider_model_id, display_name, category, description,
        input_fields, required_fields, input_schema, output_schema, metadata, provider_enabled, coming_soon)
      values ('muapi', v_item->>'provider_model_id', v_item->>'display_name', v_item->>'category', v_item->>'description',
        v_item->'input_fields', v_item->'required_fields', nullif(v_item->'input_schema','null'::jsonb),
        nullif(v_item->'output_schema','null'::jsonb), coalesce(v_item->'metadata','{}'::jsonb),
        (v_item->>'provider_enabled')::boolean, (v_item->>'coming_soon')::boolean)
      returning id into v_id;
      insert into saas_ugc.studio_ai_catalog_changes(sync_id,model_id,change_type,after_metadata)
        values (v_sync,v_id,'added',v_item);
      v_added := v_added + 1;
    else
      v_before := jsonb_build_object('display_name',v_old.display_name,'category',v_old.category,'description',v_old.description,
        'input_fields',v_old.input_fields,'required_fields',v_old.required_fields,'input_schema',v_old.input_schema,
        'output_schema',v_old.output_schema,'metadata',v_old.metadata,'provider_enabled',v_old.provider_enabled,'coming_soon',v_old.coming_soon);
      -- Missing schemas in a list response do not erase previously retrieved detail.
      v_after := jsonb_build_object('display_name',v_item->>'display_name','category',v_item->>'category','description',v_item->>'description',
        'input_fields',v_item->'input_fields','required_fields',v_item->'required_fields',
        'input_schema',coalesce(nullif(v_item->'input_schema','null'::jsonb),v_old.input_schema),
        'output_schema',coalesce(nullif(v_item->'output_schema','null'::jsonb),v_old.output_schema),
        'metadata',v_item->'metadata','provider_enabled',(v_item->>'provider_enabled')::boolean,'coming_soon',(v_item->>'coming_soon')::boolean);
      update saas_ugc.studio_ai_models set display_name=v_after->>'display_name', category=v_after->>'category', description=v_after->>'description',
        input_fields=v_after->'input_fields', required_fields=v_after->'required_fields',
        input_schema=nullif(v_after->'input_schema','null'::jsonb), output_schema=nullif(v_after->'output_schema','null'::jsonb),
        metadata=v_after->'metadata', provider_enabled=(v_after->>'provider_enabled')::boolean, coming_soon=(v_after->>'coming_soon')::boolean,
        public_catalog_present=true, last_seen_at=now(), updated_at=case when v_before is distinct from v_after or not v_old.public_catalog_present then now() else v_old.updated_at end
      where id=v_old.id;
      if v_before is distinct from v_after or not v_old.public_catalog_present then
        insert into saas_ugc.studio_ai_catalog_changes(sync_id,model_id,change_type,before_metadata,after_metadata)
          values (v_sync,v_old.id,case when not v_old.public_catalog_present then 'reappeared' else 'changed' end,v_before,v_after);
        v_changed := v_changed + 1;
      end if;
    end if;
  end loop;
  -- Only public presence is changed: do not infer account availability or delete rows.
  with missing as (
    update saas_ugc.studio_ai_models m set public_catalog_present=false, updated_at=now()
     where m.provider_key='muapi' and m.public_catalog_present
       and not exists (select 1 from jsonb_array_elements(p_models) x where x->>'provider_model_id'=m.provider_model_id)
     returning m.id
  ), audit as (
    insert into saas_ugc.studio_ai_catalog_changes(sync_id,model_id,change_type)
      select v_sync,id,'missing' from missing returning 1
  ) select count(*) into v_missing from audit;
  return jsonb_build_object('sync_id',v_sync,'total',v_count,'added',v_added,'changed',v_changed,'missing',v_missing);
end $$;
revoke all on function public.studio_sync_muapi_catalog(jsonb,text) from public, anon, authenticated;
grant execute on function public.studio_sync_muapi_catalog(jsonb,text) to service_role;
