-- =============================================================================
-- Business Grow — durcissement du système de crédits
-- Migration ADDITIVE : aucune donnée supprimée ni modifiée.
--
-- Trois défauts réels corrigés (vérifiés sur le code en production) :
--
-- 1. IDÉMPOTENCE DES OPÉRATIONS DE CRÉDIT. Sans contrainte, un second appel de
--    bg_capture_units sur la même demande (retry après timeout, rejeu manuel)
--    accordait à nouveau le remboursement (refund = réservé - réel) et
--    double-comptait period_used / lifetime_consumed. bg_reserve_units et
--    bg_release_units exposaient la même classe de défaut. Une index unique
--    partielle (request_id, kind) rend chaque opération de crédit idempotente :
--    le rejeu renvoie l'état courant sans toucher au portefeuille.
--
-- 2. JOURNAL IMMUABLE (append-only). Le journal saas_business.credit_ledger
--    n'avait aucune garde structurelle, alors que le journal Studio UGC est
--    protégé (ugc_credit_ledger_immutable, migration 20261112100000). Un
--    trigger bloque désormais toute mise à jour et toute suppression, à
--    l'exception de l'anonymisation de compte (user_id → NULL, rien d'autre
--    modifié) — même schéma que le correctif Studio. La FK devient
--    ON DELETE SET NULL (au lieu de CASCADE) pour que la suppression d'un
--    compte anonymise le journal au lieu de l'effacer.
--
-- 3. RÉSERVATIONS ORPHELINES. Une demande réservée puis interrompue (crash ou
--    timeout de la Edge Function entre la réservation et le capture/release)
--    bloquait les unités réservées indéfiniment. bg_release_stale_reservations
--    libère les réservations dont la demande est absente du catalogue ou
--    bloquée dans un état non terminal au-delà d'un âge maximal ; un job
--    pg_cron (15 minutes) l'exécute en continu. La libération est plafonnée
--    par le solde réservé courant : impossible de créer des crédits.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Idempotence : une seule ligne par (demande, opération de crédit)
-- -----------------------------------------------------------------------------
create unique index if not exists bg_ledger_request_kind_uq
  on saas_business.credit_ledger(request_id, kind)
  where kind in ('reserve', 'capture', 'release') and request_id is not null;

comment on index saas_business.bg_ledger_request_kind_uq is
  'Idempotence des opérations de crédit : une même demande ne peut être réservée, capturée ou libérée qu''une fois. Les rejeus renvoyent l''état courant sans effet de solde.';

-- -----------------------------------------------------------------------------
-- 2. Journal immuable (append-only) + anonymisation de compte
-- -----------------------------------------------------------------------------
-- La suppression d'un compte anonymise le journal (user_id → NULL) au lieu de
-- supprimer les lignes : l'historique financier reste auditable et le compte
-- peut être supprimé sans échec en cascade.
do $$
declare v_fkey text;
begin
  for v_fkey in
    select conname from pg_constraint
     where conrelid = 'saas_business.credit_ledger'::regclass
       and contype = 'f' and confrelid = 'auth.users'::regclass
  loop
    execute format('alter table saas_business.credit_ledger drop constraint %I', v_fkey);
  end loop;
  alter table saas_business.credit_ledger alter column user_id drop not null;
  alter table saas_business.credit_ledger
    add constraint credit_ledger_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;
end $$;

create or replace function saas_business.bg_credit_ledger_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Anonymisation autorisée (et UNIQUEMENT celle-là) : lors de la suppression
  -- du compte et/ou de la demande, les FK ON DELETE SET NULL mettent user_id
  -- et/ou request_id à NULL. Chaque transition est une UPDATE qui ne modifie
  -- que cette colonne ; la ligne n'est jamais supprimée par cette voie.
  -- Toute autre mise à jour (changement de delta, de kind, de solde, de
  -- référence non-NULL, …) et toute suppression sont refusées.
  if tg_op = 'UPDATE'
     and new.id = old.id
     and new.delta = old.delta
     and new.balance_after = old.balance_after
     and new.kind = old.kind
     and new.reason is not distinct from old.reason
     and new.created_at = old.created_at
     and (new.user_id is null or new.user_id = old.user_id)
     and (new.request_id is null or new.request_id = old.request_id)
     and (new.user_id is distinct from old.user_id
          or new.request_id is distinct from old.request_id) then
    return new;
  end if;
  raise exception 'Business Grow credit ledger is append-only';
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'saas_business.credit_ledger'::regclass
       and tgname = 'bg_credit_ledger_immutable'
       and not tgisinternal
  ) then
    create trigger bg_credit_ledger_immutable
      before update or delete on saas_business.credit_ledger
      for each row execute function saas_business.bg_credit_ledger_guard();
  end if;
end $$;

revoke all on function saas_business.bg_credit_ledger_guard() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Fonctions de crédit idempotentes
-- -----------------------------------------------------------------------------
-- L'ordre dans chaque fonction est crucial et identique :
--   1) verrou de ligne du portefeuille (bg_ensure_wallet → FOR UPDATE) ;
--   2) contrôle de solde (reserve) ;
--   3) insertion de la ligne journal AVANT la mutation du portefeuille, avec
--      ON CONFLICT DO NOTHING : c'est elle qui rend l'opération idempotente.
--      `balance_after` porte le solde APRÈS opération (cohérent avec les
--      lignes existantes et avec CHECK balance_after >= 0) ;
--   4) en cas de conflit (rejeu) : renvoyer l'état courant, sans rien toucher ;
--   5) sinon : mutation du portefeuille.
-- Le verrou FOR UPDATE du portefeuille sérialise deux appels concurrents sur
-- la même demande : le second retombe sur le conflit du journal.

create or replace function saas_business.bg_reserve_units(
  p_user_id uuid, p_request_id uuid, p_amount integer, p_reason text default 'ai_request'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
declare v_w saas_business.wallets%rowtype;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid reserve amount'; end if;
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  if v_w.available_units < p_amount then raise exception 'BG_INSUFFICIENT_QUOTA'; end if;

  insert into saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  values (p_user_id, p_request_id, -p_amount, v_w.available_units - p_amount, 'reserve',
          coalesce(nullif(p_reason, ''), 'ai_request'))
  on conflict (request_id, kind) where kind in ('reserve', 'capture', 'release') and request_id is not null
    do nothing;
  if not found then
    -- Rejeu : la demande a déjà été réservée. Aucune seconde déduction.
    select * into v_w from saas_business.wallets where user_id = p_user_id;
    return jsonb_build_object(
      'already_processed', true,
      'available_units', v_w.available_units,
      'reserved_units', v_w.reserved_units
    );
  end if;

  update saas_business.wallets
  set available_units = available_units - p_amount,
      reserved_units = reserved_units + p_amount
  where user_id = p_user_id
  returning * into v_w;
  return jsonb_build_object(
    'already_processed', false,
    'available_units', v_w.available_units,
    'reserved_units', v_w.reserved_units
  );
end $$;

create or replace function saas_business.bg_capture_units(
  p_user_id uuid, p_request_id uuid, p_reserved integer, p_actual integer
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
declare
  v_w saas_business.wallets%rowtype;
  v_refund integer := greatest(0, coalesce(p_reserved, 0) - greatest(1, coalesce(p_actual, 1)));
  v_charged integer := greatest(1, least(coalesce(p_reserved, 1), coalesce(p_actual, 1)));
begin
  v_w := saas_business.bg_ensure_wallet(p_user_id);

  insert into saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  values (p_user_id, p_request_id, 0, v_w.available_units + v_refund, 'capture', 'Exécution IA Business Grow')
  on conflict (request_id, kind) where kind in ('reserve', 'capture', 'release') and request_id is not null
    do nothing;
  if not found then
    -- Rejeu : la demande a déjà été capturée. Aucun second remboursement,
    -- aucun second comptage de période.
    select * into v_w from saas_business.wallets where user_id = p_user_id;
    return jsonb_build_object(
      'already_processed', true,
      'domain', 'business_grow',
      'studio_ugc_untouched', true,
      'available_units', v_w.available_units,
      'reserved_units', v_w.reserved_units,
      'charged_units', v_charged
    );
  end if;

  update saas_business.wallets
  set reserved_units = greatest(0, reserved_units - coalesce(p_reserved, 0)),
      available_units = available_units + v_refund,
      period_used = period_used + v_charged,
      lifetime_consumed = lifetime_consumed + v_charged
  where user_id = p_user_id
  returning * into v_w;
  return jsonb_build_object(
    'already_processed', false,
    'domain', 'business_grow',
    'studio_ugc_untouched', true,
    'available_units', v_w.available_units,
    'reserved_units', v_w.reserved_units,
    'charged_units', v_charged
  );
end $$;

create or replace function saas_business.bg_release_units(
  p_user_id uuid, p_request_id uuid, p_amount integer, p_reason text default 'ai_refund'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
declare
  v_w saas_business.wallets%rowtype;
  v_refund integer;
begin
  if p_amount is null or p_amount <= 0 then return saas_business.bg_quota_status(p_user_id); end if;
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  v_refund := least(p_amount, v_w.reserved_units);

  insert into saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  values (p_user_id, p_request_id, p_amount, v_w.available_units + v_refund, 'release',
          coalesce(nullif(p_reason, ''), 'ai_refund'))
  on conflict (request_id, kind) where kind in ('reserve', 'capture', 'release') and request_id is not null
    do nothing;
  if not found then
    -- Rejeu : la demande a déjà été libérée.
    select * into v_w from saas_business.wallets where user_id = p_user_id;
    return jsonb_build_object(
      'already_processed', true,
      'available_units', v_w.available_units,
      'reserved_units', v_w.reserved_units
    );
  end if;

  update saas_business.wallets
  set available_units = available_units + v_refund,
      reserved_units = greatest(0, reserved_units - p_amount)
  where user_id = p_user_id
  returning * into v_w;
  return jsonb_build_object(
    'already_processed', false,
    'available_units', v_w.available_units,
    'reserved_units', v_w.reserved_units
  );
end $$;

-- -----------------------------------------------------------------------------
-- 4. Libération des réservations orphelines (maintenance)
-- -----------------------------------------------------------------------------
create or replace function saas_business.bg_release_stale_reservations(
  p_max_age interval default interval '15 minutes'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
declare
  v_stale record;
  v_released_requests integer := 0;
  v_released_units integer := 0;
  v_skipped_orphan integer := 0;
  v_before integer;
  v_after integer;
begin
  -- Réservations sans capture ni release associée, dont la demande est bloquée
  -- hors terminal (queued/running) depuis plus de p_max_age.
  --
  -- Idempotence : la libération passe par bg_release_units qui insère une
  -- ligne 'release' pour ce request_id ; la garde `NOT EXISTS` empêche tout
  -- rejeu. On ne traite que les request_id NON NULL : une demande effacée
  -- (FK ON DELETE SET NULL) rendrait l'identifiant NULL et casserait
  -- l'idempotence (NULL = NULL n'est jamais vrai) — au lieu de risquer une
  -- libération répétée (création de crédits), ces orphelins comptés mais
  -- laissés réservés, direction sûre (aucun crédit créé, aucun double-release).
  for v_stale in
    select l.user_id, l.request_id, (-l.delta)::integer as reserved_amount
    from saas_business.credit_ledger l
    join saas_business.ai_requests r on r.id = l.request_id
    where l.kind = 'reserve'
      and l.request_id is not null
      and r.status in ('queued', 'running')
      and r.updated_at < now() - p_max_age
      and not exists (
        select 1 from saas_business.credit_ledger x
         where x.request_id = l.request_id and x.kind in ('capture', 'release')
      )
    order by l.created_at
  loop
    if v_stale.user_id is null then continue; end if; -- compte supprimé : anonymisé
    select coalesce(w.available_units, 0) into v_before
      from saas_business.wallets w where w.user_id = v_stale.user_id;
    perform saas_business.bg_release_units(
      v_stale.user_id, v_stale.request_id, v_stale.reserved_amount,
      'stale_reservation_timeout'
    );
    select coalesce(w.available_units, 0) into v_after
      from saas_business.wallets w where w.user_id = v_stale.user_id;
    v_released_requests := v_released_requests + 1;
    v_released_units := v_released_units + greatest(0, v_after - v_before);
  end loop;

  -- Orphelins sans demande (request_id NULL) : comptés pour traçabilité,
  -- laissés réservés (aucune libération non idempotente).
  select count(*) into v_skipped_orphan
    from saas_business.credit_ledger l
   where l.kind = 'reserve' and l.request_id is null;

  return jsonb_build_object(
    'released_requests', v_released_requests,
    'released_units', v_released_units,
    'skipped_orphans', v_skipped_orphan,
    'at', now()::text
  );
end $$;

-- Maintenance serveur : exécutée par le job pg_cron (propriétaire) et mise à
-- disposition du rôle worker de facturation ; jamais accessible aux rôles
-- client.
revoke all on function saas_business.bg_release_stale_reservations(interval) from public, anon, authenticated, service_role, bg_edge, bg_erasure;
grant execute on function saas_business.bg_release_stale_reservations(interval) to bg_billing_worker;

-- -----------------------------------------------------------------------------
-- 5. Job pg_cron (idempotent : un seul job par nom)
-- -----------------------------------------------------------------------------
do $$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname = 'business-grow-stale-reservations' loop
    perform cron.unschedule(v_job);
  end loop;
end $$;

-- Toutes les 15 minutes : libère les réservations orphelines (crash/timeout
-- entre réservation et capture/release).
select cron.schedule(
  'business-grow-stale-reservations',
  '*/15 * * * *',
  $$select saas_business.bg_release_stale_reservations(interval '15 minutes')$$
);
