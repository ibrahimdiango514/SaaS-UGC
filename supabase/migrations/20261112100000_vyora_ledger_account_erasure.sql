-- Suppression de compte : le journal de crédits doit rester immuable, mais la
-- clé étrangère `user_id → auth.users ON DELETE SET NULL` déclenche le trigger
-- append-only et fait donc ÉCHOUER la suppression d'un compte possédant un
-- historique de crédits (erreur « UGC credit ledger is append-only »).
--
-- Correctif : le trigger autorise désormais l'unique mutation produite par la
-- suppression du compte (user_id devient NULL), et rien d'autre n'est modifié
-- (le reste de la ligne est vérifié inchangé, la ligne ne peut pas être
-- supprimée par cette voie). L'anonymisation est réelle : aucune ligne du
-- journal n'est effacée, seule la référence au compte disparaît.
--
-- Les insertions et toutes les autres mises à jour restent interdites.
create or replace function ugc_private.reject_ledger_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Suppression du compte (FK ON DELETE SET NULL) : anonymisation autorisée,
  -- et uniquement celle-là.
  if tg_op = 'UPDATE'
     and old.user_id is not null
     and new.user_id is null
     and new.id = old.id
     and new.operation_type = old.operation_type
     and new.available_delta = old.available_delta
     and new.reserved_delta = old.reserved_delta
     and new.idempotency_key is not distinct from old.idempotency_key
     and new.generation_job_id is not distinct from old.generation_job_id
     and new.recharge_order_id is not distinct from old.recharge_order_id
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'UGC credit ledger is append-only';
end $$;

-- Le trigger existant réutilise la fonction mise à jour : aucune recréation
-- nécessaire. On vérifie simplement qu'il est bien en place.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'saas_ugc.ugc_credit_ledger'::regclass
       and tgname = 'ugc_credit_ledger_immutable'
       and not tgisinternal
  ) then
    create trigger ugc_credit_ledger_immutable
      before delete or update on saas_ugc.ugc_credit_ledger
      for each row execute function ugc_private.reject_ledger_mutation();
  end if;
end $$;
