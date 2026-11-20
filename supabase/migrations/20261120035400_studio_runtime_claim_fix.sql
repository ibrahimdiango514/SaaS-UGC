create or replace function public.studio_runtime_due(p_job_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 update saas_ugc.studio_runtime_jobs set status='uncertain',error_code='SUBMISSION_UNCERTAIN' where status='submitting' and created_at<now()-interval '5 minutes';
 perform public.studio_runtime_expire();
 with due as(select id from saas_ugc.studio_runtime_jobs where status='processing' and poll_after<now() and (p_job_id is null or id=p_job_id) order by poll_after for update skip locked limit 3), claimed as(update saas_ugc.studio_runtime_jobs j set poll_after=now()+interval '2 minutes' from due where due.id=j.id returning j.*) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into result from claimed;
 return result;
end $$;
