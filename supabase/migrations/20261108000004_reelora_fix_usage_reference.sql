-- Corrects the quota usage reference so cancelling a job refunds its monthly quota.
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

revoke all on function public.reelora_start_generation(uuid, text, jsonb) from public, anon;
grant execute on function public.reelora_start_generation(uuid, text, jsonb) to authenticated, service_role;
