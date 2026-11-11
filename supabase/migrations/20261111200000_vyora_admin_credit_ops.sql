-- VYORA — opérations de crédits administrateur réellement exécutables.
--
-- Remplace l'usage direct de reelora_admin_adjust_credits par deux fonctions qui
-- ajoutent ce qui manquait pour un centre de contrôle sérieux :
--   * contrôle du solde AVANT écriture (refus explicite si insuffisant) ;
--   * clé d'idempotence fournie par l'appelant (protection double-clic / rejeu) ;
--   * motif obligatoire (>= 3 caractères) et identifiant de l'administrateur ;
--   * solde avant / après renvoyés à l'interface ;
--   * journal d'audit avec l'acteur, la variation, les soldes et la clé utilisée ;
--   * historique de mouvements lisible par l'administrateur.
--
-- Les écritures restent faites par ugc_private.apply_wallet_delta (verrou de
-- ligne, ledger immuable, idempotence par (user_id, idempotency_key)).
-- Aucune donnée existante n'est modifiée : uniquement des ajouts.

create or replace function public.vyora_admin_credit_movement(
  p_user_id uuid,
  p_delta bigint,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_before bigint;
  v_after bigint;
  v_ledger uuid;
  v_existing uuid;
  v_replayed boolean := false;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  perform ugc_private.reelora_assert_admin();

  if p_delta is null or p_delta = 0 or p_delta < -100000 or p_delta > 100000 then
    raise exception 'invalid_delta';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'reason_required';
  end if;
  if v_key is null or length(v_key) < 8 then
    raise exception 'idempotency_key_required';
  end if;
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;

  select available_balance into v_before
  from saas_ugc.ugc_wallets where user_id = p_user_id;
  if v_before is null then
    raise exception 'wallet_not_found';
  end if;

  select id into v_existing
  from saas_ugc.ugc_credit_ledger
  where user_id = p_user_id and idempotency_key = 'admin:' || v_key;

  if v_existing is null and v_before + p_delta < 0 then
    raise exception 'insufficient_balance:%', v_before;
  end if;

  v_ledger := ugc_private.apply_wallet_delta(
    p_user_id,
    'admin_adjustment',
    p_delta,
    0,
    'admin:' || v_key,
    btrim(p_reason),
    jsonb_build_object('actor_user_id', v_actor, 'source', 'admin_console')
  );
  v_replayed := v_existing is not null;

  select available_balance into v_after
  from saas_ugc.ugc_wallets where user_id = p_user_id;

  if not v_replayed then
    insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
    values (
      v_actor, 'adjust_credits', 'user', p_user_id::text,
      jsonb_build_object(
        'delta', p_delta,
        'reason', btrim(p_reason),
        'balance_before', v_before,
        'balance_after', v_after,
        'ledger_id', v_ledger,
        'idempotency_key', v_key
      )
    );
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'delta', case when v_replayed then 0 else p_delta end,
    'requested_delta', p_delta,
    'reason', btrim(p_reason),
    'balance_before', v_before,
    'balance_after', v_after,
    'ledger_id', v_ledger,
    'replayed', v_replayed,
    'actor_user_id', v_actor,
    'applied_at', now()
  );
end;
$function$;

create or replace function public.vyora_admin_credit_history(
  p_user_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_limit integer := greatest(1, least(200, coalesce(p_limit, 50)));
begin
  perform ugc_private.reelora_assert_admin();

  return jsonb_build_object(
    'user_id', p_user_id,
    'balance', coalesce((select available_balance from saas_ugc.ugc_wallets where user_id = p_user_id), 0),
    'reserved', coalesce((select reserved_balance from saas_ugc.ugc_wallets where user_id = p_user_id), 0),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'delta', l.available_delta,
        'reserved_delta', l.reserved_delta,
        'operation', l.operation_type,
        'description', l.description,
        'metadata', l.metadata,
        'created_at', l.created_at
      ) order by l.created_at desc)
      from (
        select * from saas_ugc.ugc_credit_ledger
        where user_id = p_user_id
        order by created_at desc
        limit v_limit
      ) l
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.vyora_admin_credit_movement(uuid, bigint, text, text) is
  'Ajustement de crédits administrateur : idempotent, contrôlé, audité, renvoie le solde avant/après.';
comment on function public.vyora_admin_credit_history(uuid, integer) is
  'Historique des mouvements de crédits d’un client, réservé à l’administration.';

revoke all on function public.vyora_admin_credit_movement(uuid, bigint, text, text) from public;
revoke all on function public.vyora_admin_credit_history(uuid, integer) from public;
grant execute on function public.vyora_admin_credit_movement(uuid, bigint, text, text) to authenticated;
grant execute on function public.vyora_admin_credit_history(uuid, integer) to authenticated;
