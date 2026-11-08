-- Reelora v1 — server-side business logic (RPC). All functions are SECURITY DEFINER
-- with an explicit auth.uid()/role check, and none expose a service key to the browser.

create or replace function ugc_private.reelora_assert_active()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if exists (select 1 from saas_ugc.ugc_subscriptions s where s.user_id = (select auth.uid()) and s.status <> 'active') then
    raise exception 'account_not_active';
  end if;
end $$;

create or replace function public.reelora_bootstrap()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_ws uuid; v_plan text; v_credits bigint;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  insert into saas_ugc.ugc_profiles(user_id) values (v_uid) on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_wallets(user_id) values (v_uid) on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_subscriptions(user_id, plan_key) values (v_uid, 'free') on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_user_roles(user_id, role) values (v_uid, 'user') on conflict (user_id, role) do nothing;
  v_ws := saas_ugc.ugc_ensure_my_workspace();
  if not exists (select 1 from saas_ugc.ugc_generation_presets p where p.workspace_id = v_ws) then
    insert into saas_ugc.ugc_generation_presets(workspace_id, created_by, name, config, is_default)
    values (v_ws, v_uid, 'Réglages standard',
            '{"duration_seconds":15,"aspect_ratio":"9:16","style":"ugc_naturel","voice_speed":1,"captions":true,"resolution":"1080p"}'::jsonb, true);
  end if;
  select s.plan_key into v_plan from saas_ugc.ugc_subscriptions s where s.user_id = v_uid;
  select w.available_balance into v_credits from saas_ugc.ugc_wallets w where w.user_id = v_uid;
  return jsonb_build_object('user_id', v_uid, 'workspace_id', v_ws, 'plan', v_plan,
                            'credits', coalesce(v_credits, 0), 'is_admin', saas_ugc.ugc_is_admin());
end $$;

create or replace function public.reelora_quota_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_plan saas_ugc.ugc_plans%rowtype;
        v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select p.* into v_plan from saas_ugc.ugc_subscriptions s
    join saas_ugc.ugc_plans p on p.plan_key = s.plan_key where s.user_id = v_uid;
  if not found then select * into v_plan from saas_ugc.ugc_plans where plan_key = 'free'; end if;
  return jsonb_build_object(
    'plan', to_jsonb(v_plan),
    'status', coalesce((select s.status from saas_ugc.ugc_subscriptions s where s.user_id = v_uid), 'active'),
    'credits', coalesce((select w.available_balance from saas_ugc.ugc_wallets w where w.user_id = v_uid), 0),
    'period', v_period,
    'projects', (select count(*) from saas_ugc.ugc_video_projects p where p.created_by = v_uid and p.status <> 'archived'),
    'avatars', (select count(*) from saas_ugc.ugc_avatars a where a.created_by = v_uid and a.status = 'active'),
    'usage', coalesce((select jsonb_object_agg(u.event_kind, u.used) from (
        select e.event_kind, sum(e.quantity) as used from saas_ugc.ugc_usage_events e
        where e.user_id = v_uid and e.period_key = v_period group by e.event_kind) u), '{}'::jsonb),
    'period_end', coalesce((select s.current_period_end from saas_ugc.ugc_subscriptions s where s.user_id = v_uid), now() + interval '1 month')
  );
end $$;

create or replace function public.reelora_consume_quota(p_kind text, p_reference_id uuid default null, p_metadata jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_plan saas_ugc.ugc_plans%rowtype;
        v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
        v_limit integer; v_used integer;
begin
  perform ugc_private.reelora_assert_active();
  if p_kind not in ('script','prompt','video','image','export') then raise exception 'invalid_quota_kind'; end if;
  select p.* into v_plan from saas_ugc.ugc_subscriptions s
    join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
    where s.user_id = v_uid and s.status = 'active';
  if not found then select * into v_plan from saas_ugc.ugc_plans where plan_key = 'free'; end if;
  v_limit := case p_kind
    when 'script' then v_plan.max_scripts_per_month
    when 'prompt' then v_plan.max_prompts_per_month
    when 'video' then v_plan.max_videos_per_month
    when 'image' then greatest(v_plan.max_videos_per_month * 2, 1)
    else 100 end;
  select coalesce(sum(e.quantity), 0) into v_used from saas_ugc.ugc_usage_events e
    where e.user_id = v_uid and e.period_key = v_period and e.event_kind = p_kind;
  if v_used + 1 > v_limit then
    raise exception 'quota_exceeded:%:%:%', p_kind, v_used, v_limit;
  end if;
  insert into saas_ugc.ugc_usage_events(user_id, event_kind, period_key, reference_id, metadata)
  values (v_uid, p_kind, v_period, p_reference_id, coalesce(p_metadata, '{}'::jsonb));
  return jsonb_build_object('kind', p_kind, 'used', v_used + 1, 'limit', v_limit, 'remaining', v_limit - v_used - 1);
end $$;

create or replace function public.reelora_create_project(
  p_title text, p_brief text default null, p_platform text default 'TikTok',
  p_language text default 'fr', p_aspect_ratio text default '9:16',
  p_campaign_objective text default null, p_target_audience text default null,
  p_target_market text default null, p_settings jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_ws uuid; v_plan saas_ugc.ugc_plans%rowtype; v_count integer; v_id uuid;
begin
  perform ugc_private.reelora_assert_active();
  select p.* into v_plan from saas_ugc.ugc_subscriptions s join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
    where s.user_id = v_uid and s.status = 'active';
  if not found then select * into v_plan from saas_ugc.ugc_plans where plan_key = 'free'; end if;
  select count(*) into v_count from saas_ugc.ugc_video_projects p where p.created_by = v_uid and p.status <> 'archived';
  if v_count >= v_plan.max_projects then raise exception 'project_limit_reached:%', v_plan.max_projects; end if;
  v_ws := saas_ugc.ugc_ensure_my_workspace();
  insert into saas_ugc.ugc_video_projects(workspace_id, created_by, title, brief, platform, language, aspect_ratio,
      campaign_objective, target_audience, target_market, settings)
  values (v_ws, v_uid, btrim(p_title), p_brief, p_platform, p_language, p_aspect_ratio,
      p_campaign_objective, p_target_audience, p_target_market, coalesce(p_settings, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reelora_save_script(
  p_project_id uuid, p_script_text text, p_hook text default '', p_call_to_action text default '',
  p_marketing_angle text default null, p_language text default 'fr', p_claims_to_avoid jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_version integer; v_id uuid; v_ws uuid;
begin
  perform ugc_private.reelora_assert_active();
  select p.workspace_id into v_ws from saas_ugc.ugc_video_projects p where p.id = p_project_id;
  if v_ws is null or not ugc_private.can_edit_workspace(v_ws) then raise exception 'forbidden'; end if;
  select coalesce(max(s.version), 0) + 1 into v_version from saas_ugc.ugc_project_scripts s
    where s.project_id = p_project_id and s.language = p_language;
  update saas_ugc.ugc_project_scripts set status = 'superseded' where project_id = p_project_id and language = p_language;
  insert into saas_ugc.ugc_project_scripts(project_id, version, language, marketing_angle, hook, script_text,
      call_to_action, claims_to_avoid, status, created_by)
  values (p_project_id, v_version, p_language, p_marketing_angle, p_hook, p_script_text,
      p_call_to_action, coalesce(p_claims_to_avoid, '[]'::jsonb), 'draft', v_uid)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reelora_save_scenes(p_project_id uuid, p_script_id uuid default null, p_scenes jsonb default '[]'::jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_scene jsonb; v_count integer := 0;
begin
  select p.workspace_id into v_ws from saas_ugc.ugc_video_projects p where p.id = p_project_id;
  if v_ws is null or not ugc_private.can_edit_workspace(v_ws) then raise exception 'forbidden'; end if;
  delete from saas_ugc.ugc_project_scenes where project_id = p_project_id;
  for v_scene in select value from jsonb_array_elements(coalesce(p_scenes, '[]'::jsonb)) loop
    insert into saas_ugc.ugc_project_scenes(project_id, script_id, scene_order, duration_seconds, scene_type,
        visual_prompt, spoken_text, subtitle_text, scene_settings)
    values (p_project_id, p_script_id, v_count + 1,
        least(greatest(coalesce((v_scene->>'duration_seconds')::numeric, 3), 1), 120),
        coalesce(nullif(v_scene->>'scene_type', ''), 'ugc'),
        v_scene->>'visual_prompt', v_scene->>'spoken_text', v_scene->>'subtitle_text',
        coalesce((v_scene->'scene_settings')::jsonb, '{}'::jsonb));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.reelora_start_generation(p_project_id uuid, p_service_key text, p_payload jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_project saas_ugc.ugc_video_projects%rowtype;
        v_service saas_ugc.ugc_service_catalog%rowtype; v_balance bigint; v_job uuid; v_key text;
begin
  perform ugc_private.reelora_assert_active();
  select * into v_project from saas_ugc.ugc_video_projects p where p.id = p_project_id;
  if not found or not ugc_private.can_edit_workspace(v_project.workspace_id) then raise exception 'forbidden'; end if;
  select * into v_service from saas_ugc.ugc_service_catalog s where s.service_key = p_service_key and s.active = true;
  if not found then raise exception 'service_unavailable'; end if;
  select w.available_balance into v_balance from saas_ugc.ugc_wallets w where w.user_id = v_uid;
  if coalesce(v_balance, 0) < v_service.credits_cost then raise exception 'insufficient_credits'; end if;
  insert into saas_ugc.ugc_generation_jobs(workspace_id, project_id, created_by, service_key, status,
      request_payload, request_key)
  values (v_project.workspace_id, p_project_id, v_uid, p_service_key, 'queued',
      coalesce(p_payload, '{}'::jsonb), 'reelora-' || gen_random_uuid()::text)
  returning id into v_job;
  perform public.reelora_consume_quota('video', v_job, jsonb_build_object('service_key', p_service_key));
  v_key := 'reserve-job:' || v_job::text;
  perform ugc_private.apply_wallet_delta(v_uid, 'reserve', -v_service.credits_cost, v_service.credits_cost,
      v_key, 'Réservation de crédits pour génération', jsonb_build_object('service_key', p_service_key), null, v_job);
  update saas_ugc.ugc_generation_jobs
     set status = 'reserved', credits_reserved = v_service.credits_cost,
         reservation_idempotency_key = v_key, updated_at = now()
   where id = v_job;
  insert into saas_ugc.ugc_job_events(generation_job_id, actor_user_id, event_type, from_status, to_status, payload)
  values (v_job, v_uid, 'submitted', 'queued', 'reserved', jsonb_build_object('credits', v_service.credits_cost));
  update saas_ugc.ugc_video_projects set status = 'queued', updated_at = now() where id = p_project_id;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_uid, 'Génération lancée', 'Votre vidéo est en file d’attente. Suivez son avancement dans l’historique.', 'info', '/app/historique');
  return v_job;
end $$;

create or replace function public.reelora_cancel_generation(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_job saas_ugc.ugc_generation_jobs%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_job from saas_ugc.ugc_generation_jobs j where j.id = p_job_id for update;
  if not found or v_job.created_by <> v_uid then raise exception 'forbidden'; end if;
  if v_job.status not in ('queued','reserved') then raise exception 'job_not_cancellable'; end if;
  if v_job.credits_reserved > 0 then
    perform ugc_private.apply_wallet_delta(v_uid, 'release', v_job.credits_reserved, -v_job.credits_reserved,
      'release-job:' || v_job.id::text, 'Génération annulée, crédits restitués', '{}'::jsonb, null, v_job.id);
  end if;
  delete from saas_ugc.ugc_usage_events where reference_id = p_job_id and event_kind = 'video' and user_id = v_uid;
  update saas_ugc.ugc_generation_jobs set status = 'cancelled', credits_reserved = 0,
      cancellation_requested_at = now(), completed_at = now(), updated_at = now() where id = p_job_id;
  insert into saas_ugc.ugc_job_events(generation_job_id, actor_user_id, event_type, from_status, to_status)
  values (p_job_id, v_uid, 'cancelled', v_job.status, 'cancelled');
  return true;
end $$;

create or replace function public.reelora_set_job_processing(
  p_job_id uuid, p_provider text, p_provider_job_id text, p_request_payload jsonb default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job saas_ugc.ugc_generation_jobs%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  select * into v_job from saas_ugc.ugc_generation_jobs j where j.id = p_job_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status in ('succeeded','failed','cancelled') then return false; end if;
  update saas_ugc.ugc_generation_jobs
     set provider = p_provider, provider_job_id = p_provider_job_id, status = 'processing',
         started_at = coalesce(started_at, now()), last_heartbeat_at = now(),
         request_payload = coalesce(p_request_payload, request_payload), updated_at = now()
   where id = p_job_id;
  insert into saas_ugc.ugc_job_events(generation_job_id, event_type, from_status, to_status, payload)
  values (p_job_id, 'provider_submitted', v_job.status, 'processing', jsonb_build_object('provider', p_provider, 'provider_job_id', p_provider_job_id));
  return true;
end $$;

create or replace function public.reelora_finalize_generation(
  p_job_id uuid, p_status text, p_storage_path text default null, p_mime_type text default 'video/mp4',
  p_file_size_bytes bigint default null, p_result_payload jsonb default '{}'::jsonb, p_error_message text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job saas_ugc.ugc_generation_jobs%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_status not in ('succeeded','failed') then raise exception 'invalid_status'; end if;
  select * into v_job from saas_ugc.ugc_generation_jobs j where j.id = p_job_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status in ('succeeded','failed','cancelled') then return false; end if;
  if p_status = 'succeeded' then
    if v_job.credits_reserved > 0 then
      perform ugc_private.apply_wallet_delta(v_job.created_by, 'capture', 0, -v_job.credits_reserved,
        'capture-job:' || v_job.id::text, 'Crédits consommés après génération',
        jsonb_build_object('job_id', v_job.id), null, v_job.id);
    end if;
    if p_storage_path is not null then
      insert into saas_ugc.ugc_generated_assets(workspace_id, project_id, generation_job_id, created_by,
          asset_type, storage_path, mime_type, file_size_bytes, metadata)
      values (v_job.workspace_id, v_job.project_id, v_job.id, v_job.created_by, 'video',
          p_storage_path, p_mime_type, p_file_size_bytes, coalesce(p_result_payload, '{}'::jsonb));
    end if;
    update saas_ugc.ugc_generation_jobs
       set status = 'succeeded', credits_charged = v_job.credits_reserved, credits_reserved = 0,
           result_payload = coalesce(p_result_payload, '{}'::jsonb), completed_at = now(), updated_at = now()
     where id = p_job_id;
    update saas_ugc.ugc_video_projects set status = 'completed', updated_at = now() where id = v_job.project_id;
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_job.created_by, 'Vidéo disponible', 'Votre création est prête dans la bibliothèque.', 'success', '/app/bibliotheque');
  else
    if v_job.credits_reserved > 0 then
      perform ugc_private.apply_wallet_delta(v_job.created_by, 'release', v_job.credits_reserved, -v_job.credits_reserved,
        'release-job:' || v_job.id::text, 'Génération échouée, crédits restitués', '{}'::jsonb, null, v_job.id);
    end if;
    update saas_ugc.ugc_generation_jobs
       set status = 'failed', credits_reserved = 0, error_code = 'provider_error',
           error_message = coalesce(p_error_message, 'La génération a échoué'),
           completed_at = now(), updated_at = now()
     where id = p_job_id;
    update saas_ugc.ugc_video_projects set status = 'failed', updated_at = now() where id = v_job.project_id;
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_job.created_by, 'Génération échouée', coalesce(p_error_message, 'Vos crédits ont été restitués.'), 'error', '/app/historique');
  end if;
  insert into saas_ugc.ugc_job_events(generation_job_id, event_type, from_status, to_status, payload)
  values (p_job_id, 'finalized', v_job.status, p_status, coalesce(p_result_payload, '{}'::jsonb));
  return true;
end $$;

create or replace function public.reelora_mark_notification_read(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update saas_ugc.ugc_notifications set read_at = now()
   where id = p_id and user_id = (select auth.uid()) and read_at is null;
  return found;
end $$;

create or replace function public.reelora_mark_all_notifications_read()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update saas_ugc.ugc_notifications set read_at = now()
   where user_id = (select auth.uid()) and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.reelora_request_plan_change(p_plan_key text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_plan saas_ugc.ugc_plans%rowtype; v_count integer := 0;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_plan from saas_ugc.ugc_plans p where p.plan_key = p_plan_key and p.active = true;
  if not found then raise exception 'plan_not_found'; end if;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  select r.user_id, 'Demande de formule', 'Un utilisateur demande la formule ' || v_plan.display_name || '.', 'admin_request', '/app/admin'
    from saas_ugc.ugc_user_roles r where r.role = 'admin';
  get diagnostics v_count = row_count;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_uid, 'Demande envoyée', 'Votre demande de passage à la formule ' || v_plan.display_name || ' a été transmise à l’administration.', 'info', '/app/abonnement');
  return v_count;
end $$;

-- Administration -------------------------------------------------------------
create or replace function ugc_private.reelora_assert_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not ugc_private.has_role((select auth.uid()), 'admin') then raise exception 'forbidden'; end if;
end $$;

create or replace function public.reelora_admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  return jsonb_build_object(
    'users', (select count(*) from saas_ugc.ugc_profiles),
    'projects', (select count(*) from saas_ugc.ugc_video_projects),
    'jobs', (select count(*) from saas_ugc.ugc_generation_jobs),
    'jobs_succeeded', (select count(*) from saas_ugc.ugc_generation_jobs where status = 'succeeded'),
    'jobs_failed', (select count(*) from saas_ugc.ugc_generation_jobs where status = 'failed'),
    'credits_charged', (select coalesce(sum(credits_charged), 0) from saas_ugc.ugc_generation_jobs),
    'credits_available', (select coalesce(sum(available_balance), 0) from saas_ugc.ugc_wallets),
    'pending_recharges', (select count(*) from saas_ugc.ugc_recharge_orders where status in ('pending','processing')),
    'assets', (select count(*) from saas_ugc.ugc_generated_assets),
    'jobs_by_status', coalesce((select jsonb_object_agg(status, n) from (
        select status, count(*) n from saas_ugc.ugc_generation_jobs group by status) x), '{}'::jsonb),
    'usage_this_month', coalesce((select jsonb_object_agg(event_kind, n) from (
        select event_kind, sum(quantity) n from saas_ugc.ugc_usage_events
        where period_key = to_char((now() at time zone 'UTC'), 'YYYY-MM') group by event_kind) y), '{}'::jsonb)
  );
end $$;

create or replace function public.reelora_admin_list_users()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'display_name', p.display_name, 'country_code', p.country_code, 'preferred_language', p.preferred_language,
      'plan_key', s.plan_key, 'subscription_status', s.status,
      'credits', coalesce(w.available_balance, 0),
      'roles', coalesce((select jsonb_agg(r.role) from saas_ugc.ugc_user_roles r where r.user_id = u.id), '[]'::jsonb),
      'projects', (select count(*) from saas_ugc.ugc_video_projects pr where pr.created_by = u.id),
      'videos', (select count(*) from saas_ugc.ugc_generation_jobs j where j.created_by = u.id and j.status = 'succeeded')
    ) order by u.created_at desc) from auth.users u
    left join saas_ugc.ugc_profiles p on p.user_id = u.id
    left join saas_ugc.ugc_subscriptions s on s.user_id = u.id
    left join saas_ugc.ugc_wallets w on w.user_id = u.id), '[]'::jsonb);
end $$;

create or replace function public.reelora_admin_set_role(p_user_id uuid, p_role text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_role not in ('admin','user') then raise exception 'invalid_role'; end if;
  if p_role = 'user' and p_user_id = (select auth.uid())
     and (select count(*) from saas_ugc.ugc_user_roles where role = 'admin') = 1 then
    raise exception 'cannot_remove_last_admin';
  end if;
  delete from saas_ugc.ugc_user_roles where user_id = p_user_id;
  insert into saas_ugc.ugc_user_roles(user_id, role) values (p_user_id, p_role);
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_role', 'user', p_user_id::text, jsonb_build_object('role', p_role));
  return true;
end $$;

create or replace function public.reelora_admin_set_account_status(p_user_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_status not in ('active','suspended','cancelled') then raise exception 'invalid_status'; end if;
  update saas_ugc.ugc_subscriptions set status = p_status, updated_at = now() where user_id = p_user_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_account_status', 'user', p_user_id::text, jsonb_build_object('status', p_status));
  return true;
end $$;

create or replace function public.reelora_admin_set_plan(p_user_id uuid, p_plan_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if not exists (select 1 from saas_ugc.ugc_plans where plan_key = p_plan_key) then raise exception 'plan_not_found'; end if;
  insert into saas_ugc.ugc_subscriptions(user_id, plan_key, status, current_period_start, current_period_end)
  values (p_user_id, p_plan_key, 'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
  on conflict (user_id) do update set plan_key = excluded.plan_key, status = 'active',
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, updated_at = now();
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (p_user_id, 'Formule mise à jour', 'Votre formule a été modifiée par un administrateur.', 'success', '/app/abonnement');
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_plan', 'user', p_user_id::text, jsonb_build_object('plan_key', p_plan_key));
  return true;
end $$;

create or replace function public.reelora_admin_adjust_credits(p_user_id uuid, p_delta bigint, p_reason text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_balance bigint;
begin
  perform ugc_private.reelora_assert_admin();
  if p_delta is null or p_delta = 0 or p_delta < -100000 or p_delta > 100000 then raise exception 'invalid_delta'; end if;
  perform ugc_private.apply_wallet_delta(p_user_id, 'admin_adjustment', p_delta, 0,
    'admin-adjustment:' || p_user_id::text || ':' || gen_random_uuid()::text,
    coalesce(p_reason, 'Ajustement administrateur'), '{}'::jsonb);
  select available_balance into v_balance from saas_ugc.ugc_wallets where user_id = p_user_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'adjust_credits', 'user', p_user_id::text,
          jsonb_build_object('delta', p_delta, 'reason', p_reason));
  return v_balance;
end $$;

create or replace function public.reelora_admin_confirm_recharge(p_order_id uuid, p_provider_reference text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_order saas_ugc.ugc_recharge_orders%rowtype;
begin
  perform ugc_private.reelora_assert_admin();
  select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'paid' then return true; end if;
  if v_order.status not in ('pending','processing') then raise exception 'order_not_payable'; end if;
  perform ugc_private.apply_wallet_delta(v_order.user_id, 'purchase', v_order.credits_to_grant, 0,
    'recharge:' || v_order.id::text, 'Recharge validée par un administrateur',
    jsonb_build_object('provider', v_order.provider, 'amount_minor', v_order.amount_minor), v_order.id, null);
  update saas_ugc.ugc_recharge_orders set status = 'paid', provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now(), updated_at = now() where id = p_order_id;
  insert into saas_ugc.ugc_payment_events(provider, provider_event_id, recharge_order_id, event_type, processing_status, payload, processed_at)
  values (v_order.provider, 'admin:' || v_order.id::text, p_order_id, 'payment_confirmed', 'processed',
          jsonb_build_object('validated_by', (select auth.uid())), now())
  on conflict (provider, provider_event_id) do nothing;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_order.user_id, 'Recharge créditée', v_order.credits_to_grant::text || ' crédits ont été ajoutés à votre solde.', 'success', '/app/abonnement');
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'confirm_recharge', 'recharge_order', p_order_id::text,
          jsonb_build_object('credits', v_order.credits_to_grant, 'amount_minor', v_order.amount_minor));
  return true;
end $$;

create or replace function public.reelora_admin_update_service(p_service_key text, p_credits_cost integer, p_active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_credits_cost < 0 or p_credits_cost > 10000 then raise exception 'invalid_cost'; end if;
  update saas_ugc.ugc_service_catalog set credits_cost = p_credits_cost, active = p_active, updated_at = now()
   where service_key = p_service_key;
  if not found then raise exception 'service_not_found'; end if;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'update_service', 'service', p_service_key,
          jsonb_build_object('credits_cost', p_credits_cost, 'active', p_active));
  return true;
end $$;

create or replace function public.reelora_admin_set_setting(p_key text, p_value jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value) values (p_key, coalesce(p_value, '{}'::jsonb))
  on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now();
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_setting', 'setting', p_key, jsonb_build_object('value', p_value));
  return true;
end $$;

create or replace function public.reelora_admin_create_promo(p_code text, p_bonus_credits bigint, p_max_redemptions integer default 100, p_expires_at timestamptz default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  insert into saas_ugc.ugc_promo_codes(code, bonus_credits, max_redemptions, expires_at)
  values (upper(btrim(p_code)), p_bonus_credits, p_max_redemptions, p_expires_at);
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'create_promo', 'promo', upper(btrim(p_code)),
          jsonb_build_object('bonus_credits', p_bonus_credits));
  return true;
end $$;

-- Lock down execution: authenticated users only; service-role-only RPCs are revoked.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'reelora_%' loop
    execute format('revoke all on function %s from public, anon', r.fn);
    execute format('grant execute on function %s to authenticated, service_role', r.fn);
  end loop;
end $$;

notify pgrst, 'reload schema';
