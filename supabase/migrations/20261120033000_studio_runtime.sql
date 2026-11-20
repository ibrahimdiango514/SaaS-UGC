-- Universal runtime: independent of the 415 historical video models.
-- Everything starts disabled. No generation, customer charge or verification is performed here.
create table saas_ugc.studio_runtime_limits (
  id boolean primary key default true check(id), enabled boolean not null default false,
  daily_usd numeric not null default 0 check(daily_usd >= 0), sync_enabled boolean not null default true
);
insert into saas_ugc.studio_runtime_limits(id) values(true);
create table saas_ugc.studio_runtime_configs (
  model_id uuid primary key references saas_ugc.studio_ai_models(id),
  credits integer check(credits between 1 and 1000000), max_cost_usd numeric check(max_cost_usd > 0 and max_cost_usd <= 1000),
  quota_kind text not null default 'video' check(quota_kind in ('video','image','script')),
  allowed_plans text[] not null default '{}', enabled boolean not null default false,
  adapter text not null default 'muapi_prediction_v1' check(adapter='muapi_prediction_v1'),
  output_kind text not null default 'media' check(output_kind in ('media','text')),
  estimate_path text check(estimate_path ~ '^/api/v1/models/[A-Za-z0-9._~-]{1,160}/estimate-cost$'),
  revision integer not null default 1, verified_hash text, verification_reference text,
  verified_at timestamptz, updated_at timestamptz not null default now()
);
create table saas_ugc.studio_runtime_quotes (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
  model_id uuid not null references saas_ugc.studio_ai_models(id), params jsonb not null,
  spec_hash text not null, config_revision integer not null, credits integer not null check(credits>0),
  estimated_usd numeric not null check(estimated_usd>0), created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '3 minutes'
);
create table saas_ugc.studio_runtime_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), workspace_id uuid not null,
  quote_id uuid not null unique references saas_ugc.studio_runtime_quotes(id),
  request_key uuid not null, model_id uuid not null references saas_ugc.studio_ai_models(id),
  status text not null check(status in ('submitting','processing','uncertain','succeeded','failed')),
  provider_id text, credits integer not null, estimated_usd numeric not null, actual_usd numeric,
  quota_kind text not null, outputs jsonb not null default '[]', error_code text,
  poll_after timestamptz not null default now()+interval '30 seconds',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,request_key)
);
create index studio_runtime_jobs_poll on saas_ugc.studio_runtime_jobs(status,poll_after);
create index studio_runtime_jobs_user on saas_ugc.studio_runtime_jobs(user_id,created_at desc);
create table saas_ugc.studio_runtime_requests(user_id uuid not null, action text not null, created_at timestamptz not null default now());
create index studio_runtime_requests_user on saas_ugc.studio_runtime_requests(user_id,created_at);
do $$ declare t text; begin foreach t in array array['studio_runtime_limits','studio_runtime_configs','studio_runtime_quotes','studio_runtime_jobs','studio_runtime_requests'] loop
 execute format('alter table saas_ugc.%I enable row level security',t);
 execute format('revoke all on saas_ugc.%I from public,anon,authenticated',t);
end loop; end $$;

create function ugc_private.studio_spec_hash(p_id uuid) returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_array(m.input_schema,m.output_schema,m.endpoint_evidence->'endpoint',m.endpoint_evidence->'endpoint_url',m.provider_enabled,m.coming_soon,m.public_catalog_present)::text)
 from saas_ugc.studio_ai_models m where m.id=p_id
$$;
revoke all on function ugc_private.studio_spec_hash(uuid) from public,anon,authenticated;

create function public.studio_runtime_access() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); ws uuid; begin
 perform ugc_private.reelora_assert_active();
 if not exists(select 1 from saas_ugc.ugc_subscriptions where user_id=uid and status='active' and (current_period_end is null or current_period_end>now())) then raise exception 'subscription_required'; end if;
 ws:=saas_ugc.ugc_ensure_my_workspace();
 return jsonb_build_object('user_id',uid,'workspace_id',ws,'credits',coalesce((select available_balance from saas_ugc.ugc_wallets where user_id=uid),0),
 'plan',(select plan_key from saas_ugc.ugc_subscriptions where user_id=uid));
end $$;

-- Raw models/params/prices are service-only. Edge allowlists the customer projection.
create function public.studio_runtime_models(p_after text default '',p_query text default '',p_category text default '',p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 if p_limit is null or p_limit<1 or p_limit>100 or p_after is null or p_query is null or length(p_query)>200 then raise exception 'invalid_pagination'; end if;
 return jsonb_build_object('total',(select count(*) from saas_ugc.studio_ai_models where provider_key='muapi'),
 'items',coalesce((select jsonb_agg(to_jsonb(x) order by x.provider_model_id collate "C") from (
 select m.*,to_jsonb(c) as runtime_config,ugc_private.studio_spec_hash(m.id) as spec_hash,
 (select enabled from saas_ugc.studio_runtime_limits where id) as runtime_enabled
 from saas_ugc.studio_ai_models m left join saas_ugc.studio_runtime_configs c on c.model_id=m.id
 where m.provider_key='muapi' and m.provider_model_id collate "C">p_after collate "C"
 and (p_query='' or strpos(lower(m.provider_model_id||' '||m.display_name||' '||m.category||' muapi '||coalesce(m.description,'')),lower(p_query))>0)
 and (p_category='' or m.category=p_category)
 order by m.provider_model_id collate "C" limit p_limit
 ) x),'[]'::jsonb),
 'categories',(select jsonb_object_agg(category,n) from(select category,count(*) n from saas_ugc.studio_ai_models where provider_key='muapi' group by category)x));
end $$;
create function public.studio_runtime_model(p_model_id text) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 return (select to_jsonb(m)||jsonb_build_object('runtime_config',to_jsonb(c),'spec_hash',ugc_private.studio_spec_hash(m.id),
 'runtime_enabled',(select enabled from saas_ugc.studio_runtime_limits where id)) from saas_ugc.studio_ai_models m
 left join saas_ugc.studio_runtime_configs c on c.model_id=m.id where provider_key='muapi' and provider_model_id=p_model_id);
end $$;
create function public.studio_runtime_admin_config(p_model_id text,p_config jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare mid uuid; c saas_ugc.studio_runtime_configs%rowtype; begin
 perform ugc_private.reelora_assert_admin();
 select id into mid from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id for update;
 if mid is null then raise exception 'model_not_found'; end if;
 if p_config is not null then
 if jsonb_typeof(p_config)<>'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in ('credits','max_cost_usd','quota_kind','allowed_plans','enabled','output_kind')) then raise exception 'invalid_config'; end if;
 insert into saas_ugc.studio_runtime_configs(model_id) values(mid) on conflict do nothing;
 select * into c from saas_ugc.studio_runtime_configs where model_id=mid for update;
 if coalesce((p_config->>'enabled')::boolean,false) and
 (c.verified_hash is distinct from ugc_private.studio_spec_hash(mid) or c.verified_at is null or c.max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric) then raise exception 'verification_required'; end if;
 if jsonb_typeof(p_config->'allowed_plans') is distinct from 'array' then raise exception 'plans_required'; end if;
 if exists(select 1 from jsonb_array_elements_text(p_config->'allowed_plans') k where not exists(select 1 from saas_ugc.ugc_plans p where p.plan_key=k and p.active)) then raise exception 'invalid_plan'; end if;
 update saas_ugc.studio_runtime_configs set credits=(p_config->>'credits')::integer,max_cost_usd=(p_config->>'max_cost_usd')::numeric,
 quota_kind=p_config->>'quota_kind',output_kind=p_config->>'output_kind',allowed_plans=array(select jsonb_array_elements_text(p_config->'allowed_plans')),
 enabled=coalesce((p_config->>'enabled')::boolean,false),revision=revision+1,
 verified_hash=case when max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric or output_kind is distinct from p_config->>'output_kind' then null else verified_hash end,
 verified_at=case when max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric or output_kind is distinct from p_config->>'output_kind' then null else verified_at end,
 updated_at=now() where model_id=mid;
 end if;
 return jsonb_build_object('config',(select to_jsonb(x) from saas_ugc.studio_runtime_configs x where model_id=mid),'spec_hash',ugc_private.studio_spec_hash(mid),
 'limits',(select to_jsonb(l) from saas_ugc.studio_runtime_limits l where id),
 'plans',coalesce((select jsonb_agg(plan_key) from saas_ugc.ugc_plans where active),'[]'::jsonb));
end $$;
-- No HTTP action can attest a live test. Explicit financial authorization and a
-- real, documented provider request are required before this service-only RPC.
create function public.studio_runtime_attest(p_model_id text,p_hash text,p_reference text) returns boolean language plpgsql security definer set search_path='' as $$
declare mid uuid; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 select id into mid from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id;
 if mid is null or p_hash is distinct from ugc_private.studio_spec_hash(mid) or length(coalesce(p_reference,''))<12 then raise exception 'verification_invalid'; end if;
 update saas_ugc.studio_runtime_configs set verified_hash=p_hash,verification_reference=p_reference,verified_at=now(),enabled=false,revision=revision+1 where model_id=mid and credits>0 and max_cost_usd>0;
 return found;
end $$;
create function public.studio_runtime_admin_limits(p_enabled boolean,p_daily_usd numeric) returns boolean language plpgsql security definer set search_path='' as $$
begin perform ugc_private.reelora_assert_admin();
 if p_enabled is null or p_daily_usd is null or p_daily_usd<0 or p_daily_usd>10000 or (p_enabled and p_daily_usd<=0) then raise exception 'invalid_limits'; end if;
 update saas_ugc.studio_runtime_limits set enabled=p_enabled,daily_usd=p_daily_usd where id; return true;
end $$;
create function public.studio_runtime_rate(p_user_id uuid,p_action text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 perform pg_advisory_xact_lock(hashtext('studio-rate-'||p_user_id::text));
 if (select count(*) from saas_ugc.studio_runtime_requests where user_id=p_user_id and action=p_action and created_at>now()-interval '1 minute')>=10 then return false; end if;
 insert into saas_ugc.studio_runtime_requests(user_id,action) values(p_user_id,p_action); return true;
end $$;
create function public.studio_runtime_issue_quote(p_user_id uuid,p_model_id uuid,p_params jsonb,p_cost numeric,p_hash text,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c saas_ugc.studio_runtime_configs%rowtype; q saas_ugc.studio_runtime_quotes%rowtype; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 select * into c from saas_ugc.studio_runtime_configs where model_id=p_model_id;
 if not found or not c.enabled or c.verified_hash is distinct from ugc_private.studio_spec_hash(p_model_id) or c.verified_at is null or c.revision is distinct from p_revision or c.verified_hash is distinct from p_hash or c.credits is null or p_cost is null or p_cost<=0 or p_cost>c.max_cost_usd or octet_length(p_params::text)>131072 then raise exception 'quote_unavailable'; end if;
 if not (select enabled from saas_ugc.studio_runtime_limits where id) then raise exception 'runtime_disabled'; end if;
 insert into saas_ugc.studio_runtime_quotes(user_id,model_id,params,spec_hash,config_revision,credits,estimated_usd)
 values(p_user_id,p_model_id,p_params,p_hash,p_revision,c.credits,p_cost) returning * into q;
 return jsonb_build_object('quote_id',q.id,'credits',q.credits,'expires_at',q.expires_at);
end $$;
create function public.studio_runtime_start(p_quote_id uuid,p_request_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); q saas_ugc.studio_runtime_quotes%rowtype; c saas_ugc.studio_runtime_configs%rowtype;
 j saas_ugc.studio_runtime_jobs%rowtype; lim saas_ugc.studio_runtime_limits%rowtype; ctx jsonb; used numeric; jid uuid:=gen_random_uuid(); begin
 ctx:=public.studio_runtime_access();
 perform pg_advisory_xact_lock(hashtext('studio-start-'||uid::text));
 select * into j from saas_ugc.studio_runtime_jobs where user_id=uid and (request_key=p_request_key or quote_id=p_quote_id);
 if found then return jsonb_build_object('id',j.id,'new',false); end if;
 select * into q from saas_ugc.studio_runtime_quotes where id=p_quote_id and user_id=uid for update;
 if not found or q.expires_at<=now() then raise exception 'quote_expired'; end if;
 select * into c from saas_ugc.studio_runtime_configs where model_id=q.model_id for update;
 if not found or not c.enabled or c.credits is null or c.credits<>q.credits or c.verified_at is null or c.verified_hash is distinct from ugc_private.studio_spec_hash(q.model_id) or c.verified_hash is distinct from q.spec_hash or c.revision<>q.config_revision or not ((ctx->>'plan')=any(c.allowed_plans)) then raise exception 'model_unavailable'; end if;
 if not exists(select 1 from saas_ugc.studio_ai_models where id=q.model_id and public_catalog_present and provider_enabled is true and coming_soon is not true) then raise exception 'model_unavailable'; end if;
 select * into lim from saas_ugc.studio_runtime_limits where id for update;
 if not lim.enabled or q.estimated_usd>c.max_cost_usd then raise exception 'runtime_disabled'; end if;
 select coalesce(sum(greatest(estimated_usd,coalesce(actual_usd,0))),0) into used from saas_ugc.studio_runtime_jobs where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 if used+q.estimated_usd>lim.daily_usd then raise exception 'daily_budget_exceeded'; end if;
 if (select count(*) from saas_ugc.studio_runtime_jobs where user_id=uid and status in ('submitting','processing','uncertain'))>=3 then raise exception 'concurrency_limit'; end if;
 perform public.reelora_consume_quota(c.quota_kind,jid,'{"source":"studio_universal"}'::jsonb);
 perform ugc_private.apply_wallet_delta(uid,'reserve',-q.credits::bigint,q.credits::bigint,'studio:reserve:'||jid::text,'Réservation Studio universel',jsonb_build_object('studio_job_id',jid));
 insert into saas_ugc.studio_runtime_jobs(id,user_id,workspace_id,quote_id,request_key,model_id,status,credits,estimated_usd,quota_kind)
 values(jid,uid,(ctx->>'workspace_id')::uuid,q.id,p_request_key,q.model_id,'submitting',q.credits,q.estimated_usd,c.quota_kind);
 return jsonb_build_object('id',jid,'new',true);
end $$;
create function public.studio_runtime_job(p_job_id uuid,p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 return (select to_jsonb(j)||jsonb_build_object('params',q.params,'provider_model_id',m.provider_model_id) from saas_ugc.studio_runtime_jobs j join saas_ugc.studio_runtime_quotes q on q.id=j.quote_id join saas_ugc.studio_ai_models m on m.id=j.model_id where j.id=p_job_id and j.user_id=p_user_id);
end $$;
create function public.studio_runtime_submitted(p_job_id uuid,p_provider_id text) returns boolean language plpgsql security definer set search_path='' as $$
begin if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 if p_provider_id is null or p_provider_id !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'invalid_provider_id'; end if;
 update saas_ugc.studio_runtime_jobs set provider_id=p_provider_id,status='processing',updated_at=now() where id=p_job_id and status='submitting'; return found;
end $$;
create function public.studio_runtime_uncertain(p_job_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 update saas_ugc.studio_runtime_jobs set status='uncertain',error_code='SUBMISSION_UNCERTAIN',updated_at=now() where id=p_job_id and status='submitting'; return found;
end $$;
create function public.studio_runtime_due(p_job_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 update saas_ugc.studio_runtime_jobs set status='uncertain',error_code='SUBMISSION_UNCERTAIN' where status='submitting' and created_at<now()-interval '5 minutes';
 return coalesce((with due as(select id from saas_ugc.studio_runtime_jobs where status='processing' and poll_after<now() and (p_job_id is null or id=p_job_id) order by poll_after for update skip locked limit 3), claimed as(update saas_ugc.studio_runtime_jobs j set poll_after=now()+interval '2 minutes' from due where due.id=j.id returning j.*) select jsonb_agg(to_jsonb(claimed)) from claimed),'[]'::jsonb);
end $$;
create function public.studio_runtime_finish(p_job_id uuid,p_status text,p_outputs jsonb,p_actual_usd numeric) returns boolean language plpgsql security definer set search_path='' as $$
declare j saas_ugc.studio_runtime_jobs%rowtype; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 if p_status not in ('succeeded','failed') or p_outputs is null or jsonb_typeof(p_outputs)<>'array' or jsonb_array_length(p_outputs)>16 or octet_length(p_outputs::text)>200000 then raise exception 'invalid_result'; end if;
 if p_status='succeeded' and jsonb_array_length(p_outputs)=0 then raise exception 'empty_result'; end if;
 select * into j from saas_ugc.studio_runtime_jobs where id=p_job_id for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status in ('succeeded','failed') then return false; end if;
 if j.status<>'processing' then raise exception 'job_not_processing'; end if;
 update saas_ugc.studio_runtime_jobs set status=p_status,outputs=p_outputs,actual_usd=greatest(coalesce(p_actual_usd,estimated_usd),0),error_code=case when p_status='failed' then 'PROVIDER_FAILED' else null end,updated_at=now() where id=j.id;
 if p_status='succeeded' then
 perform ugc_private.apply_wallet_delta(j.user_id,'capture',0,-j.credits::bigint,'studio:capture:'||j.id::text,'Génération Studio terminée',jsonb_build_object('studio_job_id',j.id));
 else
 perform ugc_private.apply_wallet_delta(j.user_id,'release',j.credits::bigint,-j.credits::bigint,'studio:release:'||j.id::text,'Génération Studio échouée',jsonb_build_object('studio_job_id',j.id));
 delete from saas_ugc.ugc_usage_events where user_id=j.user_id and reference_id=j.id and event_kind=j.quota_kind;
 end if;
 if p_actual_usd>(select max_cost_usd from saas_ugc.studio_runtime_configs where model_id=j.model_id) then
 update saas_ugc.studio_runtime_limits set enabled=false where id;
 update saas_ugc.studio_runtime_configs set enabled=false,verified_hash=null where model_id=j.model_id;
 end if;
 return true;
end $$;
create function public.studio_runtime_history(p_before timestamptz default now(),p_limit integer default 30) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform ugc_private.reelora_assert_vyora_customer();
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid_limit'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc,id desc) from(
 select j.id,j.status,j.credits,j.outputs,j.error_code,j.created_at,j.updated_at,m.display_name,m.provider_model_id from saas_ugc.studio_runtime_jobs j join saas_ugc.studio_ai_models m on m.id=j.model_id where j.user_id=auth.uid() and j.created_at<p_before order by j.created_at desc,j.id desc limit p_limit)x),'[]'::jsonb);
end $$;
create function public.studio_runtime_input(p_path text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ws uuid; begin
 perform ugc_private.reelora_assert_active();
 if p_path is null or p_path ~ '(^|/)\.\.(/|$)' or p_path !~ '^[a-f0-9-]{36}/studio-inputs/[a-f0-9-]{36}\.[a-z0-9]{1,8}$' then raise exception 'invalid_path'; end if;
 ws:=split_part(p_path,'/',1)::uuid;
 if not ugc_private.can_edit_workspace(ws) then raise exception 'forbidden'; end if;
 return (select jsonb_build_object('path',name,'metadata',metadata) from storage.objects where bucket_id='ugc-assets' and name=p_path);
end $$;
-- Strictly grant only the customer/admin RPCs; raw/financial internals service-only.
do $$ declare p record; begin for p in select oid::regprocedure as signature,proname from pg_proc where pronamespace='public'::regnamespace and proname like 'studio_runtime_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',p.signature);
 execute format('grant execute on function %s to service_role',p.signature);
 if p.proname in ('studio_runtime_access','studio_runtime_admin_config','studio_runtime_admin_limits','studio_runtime_start','studio_runtime_history','studio_runtime_input') then execute format('grant execute on function %s to authenticated',p.signature); end if;
end loop; end $$;
notify pgrst,'reload schema';

create function public.studio_runtime_sync_report() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform ugc_private.reelora_assert_admin();
 return jsonb_build_object('syncs',coalesce((select jsonb_agg(to_jsonb(s)) from(select s.*, (select count(*) from saas_ugc.studio_ai_catalog_changes c where c.sync_id=s.id) as changes from saas_ugc.studio_ai_catalog_syncs s order by synced_at desc limit 20)s),'[]'::jsonb),
 'detail_events',coalesce((select jsonb_agg(to_jsonb(e)) from(select m.provider_model_id,e.event_type,e.status,e.http_status,e.occurred_at from saas_ugc.studio_ai_detail_events e join saas_ugc.studio_ai_models m on m.id=e.model_id order by e.occurred_at desc limit 50)e),'[]'::jsonb),
 'errors',coalesce((select jsonb_agg(to_jsonb(j)) from(select id,status,error_code,created_at from saas_ugc.studio_runtime_jobs where status in ('failed','uncertain') order by created_at desc limit 50)j),'[]'::jsonb));
end $$;
revoke all on function public.studio_runtime_sync_report() from public,anon;
grant execute on function public.studio_runtime_sync_report() to authenticated;
