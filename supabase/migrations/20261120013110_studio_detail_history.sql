-- Audit futur des changements de schéma et des collectes de fiches, privé.
-- Aucune modification ni copie des 861 fiches déjà collectées.
create table saas_ugc.studio_ai_detail_events (
  id bigint generated always as identity primary key,
  model_id uuid not null references saas_ugc.studio_ai_models(id),
  event_type text not null check (event_type in ('schema_changed', 'detail_checked')),
  occurred_at timestamptz not null default now(),
  status text,
  http_status integer,
  old_input_schema jsonb,
  new_input_schema jsonb,
  old_output_schema jsonb,
  new_output_schema jsonb
);
create index studio_ai_detail_events_model_time_idx on saas_ugc.studio_ai_detail_events(model_id, occurred_at desc);
alter table saas_ugc.studio_ai_detail_events enable row level security;
revoke all on saas_ugc.studio_ai_detail_events from public, anon, authenticated;

create function ugc_private.studio_record_detail_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'studio_ai_models' then
    insert into saas_ugc.studio_ai_detail_events(model_id,event_type,old_input_schema,new_input_schema,old_output_schema,new_output_schema)
    values(new.id,'schema_changed',old.input_schema,new.input_schema,old.output_schema,new.output_schema);
  else
    insert into saas_ugc.studio_ai_detail_events(model_id,event_type,occurred_at,status,http_status)
    values(new.model_id,'detail_checked',new.checked_at,new.status,new.http_status);
  end if;
  return new;
end $$;
revoke all on function ugc_private.studio_record_detail_event() from public, anon, authenticated;
create trigger studio_ai_schema_history after update of input_schema, output_schema on saas_ugc.studio_ai_models
for each row when (old.input_schema is distinct from new.input_schema or old.output_schema is distinct from new.output_schema)
execute function ugc_private.studio_record_detail_event();
create trigger studio_ai_detail_history after insert or update on saas_ugc.studio_ai_model_details
for each row execute function ugc_private.studio_record_detail_event();
