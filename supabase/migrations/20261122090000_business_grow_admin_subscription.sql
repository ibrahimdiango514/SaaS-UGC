-- =============================================================================
-- Business Grow — activation manuelle d'un abonnement par un administrateur
--               + harmonisation du nom de l'offre (« Business Grow »).
--
-- ## Constat en production (2026-11-22)
-- `saas_business.subscriptions` est vide et les trois formules (`essentiel`,
-- `croissance`, `scale`) sont inactives, sans prix, facturation désactivée.
-- Aucun compte ne peut donc souscrire : `vyora_plan_price()` lève
-- `business_plan_not_purchasable`, et `bg_import_access()` répond
-- `NO_SUBSCRIPTION` à tout le monde. Les messages « réservé aux abonnés
-- Business Ground actifs » sont donc CORRECTS : ils décrivent un catalogue qui
-- n'est pas encore commercialisé, pas une panne.
--
-- ## Décision (validée par le propriétaire)
-- - Les prix ne sont PAS définis ; la facturation et la souscription
--   automatique restent DÉSACTIVÉES (`commercial_config.pricing.billing_enabled`
--   = false, `plans.billing_enabled` = false, `monthly_price_minor` = null).
-- - Un administrateur peut attribuer manuellement une formule à un compte
--   précis, avec une date de fin, par une RPC sécurisée et journalisée.
-- - Aucun contrôle d'accès n'est assoupli : `bg_import_access()` reste la seule
--   source de vérité, et une attribution manuelle y est soumise exactement
--   comme un abonnement payé (statut, période, formule active).
--
-- ## Ce que fait cette migration
-- 1. Rend les trois formules `active = true` : c'est le sens de « formule
--    proposée » dans `bg_import_access()` (une formule inactive ferme l'accès
--    même à un abonné). Sans prix ni `billing_enabled`, rien n'est achetable :
--    `vyora_plan_price()` refuse toujours, et la page Abonnement affiche
--    « Facturation Business Grow non activée ».
-- 2. Précise le déclencheur `guard_subscription_activation` : un abonnement
--    `active`/`trialing` exige une formule active ET (facturation activée OU
--    fournisseur `manual`). Le fournisseur `manual` n'est posé que par la RPC
--    administrateur ci-dessous ; aucun client n'écrit dans cette table (RLS).
-- 3. Crée `public.vyora_admin_set_business_subscription(...)` et
--    `public.vyora_admin_revoke_business_subscription(...)`.
-- 4. Réécrit les messages de `bg_import_access()` avec le nom réel du produit,
--    « Business Grow », sans changer la règle (logique identique, cas par cas).
-- 5. Vérifie le tout à l'application (bloc `$verif$`, sous-transactions
--    annulées : aucune donnée de test ne reste en base).
--
-- Appliquée en production le 2026-11-22 (connecteur Supabase, version
-- enregistrée `20261118084946 business_grow_admin_subscription`, horloge du
-- serveur) après une exécution à blanc complète dans une transaction annulée.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Formules proposées (toujours sans prix, facturation désactivée)
-- -----------------------------------------------------------------------------
update saas_business.plans
   set active = true
 where plan_key in ('essentiel', 'croissance', 'scale')
   and active is distinct from true;

-- Garde-fou : cette migration n'active JAMAIS la facturation ni n'invente un prix.
do $$
begin
  if exists (select 1 from saas_business.plans where billing_enabled) then
    raise exception 'plans.billing_enabled doit rester false : aucun prix n''est défini';
  end if;
  if coalesce((select (value->>'billing_enabled')::boolean
                 from saas_business.commercial_config where config_key = 'pricing'), false) then
    raise exception 'commercial_config.pricing.billing_enabled doit rester false';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2) Déclencheur d'activation : fournisseur `manual` admis sur formule active
-- -----------------------------------------------------------------------------
create or replace function saas_business.guard_subscription_activation()
returns trigger
language plpgsql
set search_path = pg_catalog, saas_business
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.id, new.user_id, new.billing_provider, new.external_customer_id, new.external_subscription_id, new.created_at)
       is distinct from
       (old.id, old.user_id, old.billing_provider, old.external_customer_id, old.external_subscription_id, old.created_at)
    then raise exception 'subscription identity is immutable'; end if;
  end if;
  if new.status in ('active', 'trialing') then
    -- Abonnement payé : la formule doit être active ET facturable.
    -- Attribution administrative (`manual`) : la formule doit être active ;
    -- aucune facturation n'intervient, donc `billing_enabled` n'est pas exigé.
    if not exists (
      select 1 from saas_business.plans p
       where p.plan_key = new.plan_key
         and p.active
         and (p.billing_enabled or new.billing_provider = 'manual')
    ) then raise exception 'billing plan is not enabled'; end if;
  end if;
  if new.status in ('active', 'trialing', 'past_due') and new.billing_provider is null then
    raise exception 'active subscription requires billing provider';
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 3) RPC administrateur — attribution manuelle, journalisée
-- -----------------------------------------------------------------------------
-- Règles :
--  * appelant : administrateur VYORA (`ugc_private.reelora_assert_admin()`,
--    rôle lu en base — jamais depuis le client) ;
--  * cible : un compte client existant (`saas_ugc.ugc_customer_accounts`),
--    qui n'est pas administrateur (même règle que `reelora_admin_set_plan`) ;
--  * formule : existante et active ;
--  * date de fin : strictement future, au plus 366 jours ;
--  * conflit : si le compte possède déjà un abonnement courant d'un AUTRE
--    fournisseur (paiement réel), on refuse — l'administrateur ne doit pas
--    écraser un abonnement payé ;
--  * une seule ligne `manual` par compte : on la met à jour (renouvellement,
--    changement de formule), sinon on l'insère ;
--  * journal : `saas_ugc.ugc_audit_logs` (avant/après) + notification au
--    compte ciblé.
create or replace function public.vyora_admin_set_business_subscription(
  p_user_id uuid,
  p_plan_key text,
  p_period_end timestamptz,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan saas_business.plans%rowtype;
  v_existing saas_business.subscriptions%rowtype;
  v_before jsonb;
  v_ref uuid := gen_random_uuid();
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_now timestamptz := now();
  v_start timestamptz;
  v_row saas_business.subscriptions%rowtype;
  v_access jsonb;
begin
  perform ugc_private.reelora_assert_admin();

  if p_user_id is null then raise exception 'target_required'; end if;
  if p_user_id = v_actor then raise exception 'self_assignment_forbidden'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'target_not_found';
  end if;
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;

  select * into v_plan from saas_business.plans where plan_key = p_plan_key;
  if not found then raise exception 'plan_not_found'; end if;
  if v_plan.active is not true then raise exception 'plan_inactive'; end if;

  if p_period_end is null or p_period_end <= v_now then
    raise exception 'period_end_must_be_future';
  end if;
  if p_period_end > v_now + interval '366 days' then
    raise exception 'period_end_too_far';
  end if;

  -- Un abonnement courant posé par un VRAI fournisseur de paiement n'est pas
  -- écrasé par une attribution manuelle.
  if exists (
    select 1 from saas_business.subscriptions s
     where s.user_id = p_user_id
       and s.billing_provider is distinct from 'manual'
       and s.status in ('active', 'trialing', 'past_due')
       and (s.current_period_end is null or s.current_period_end > v_now)
  ) then
    raise exception 'subscription_conflict';
  end if;

  select * into v_existing
    from saas_business.subscriptions s
   where s.user_id = p_user_id and s.billing_provider = 'manual'
   order by s.created_at desc
   limit 1;

  if found then
    v_before := to_jsonb(v_existing);
    -- Renouvellement : si la période courante est encore ouverte, la nouvelle
    -- période commence maintenant (pas de cumul rétroactif) ; sinon idem.
    v_start := v_now;
    update saas_business.subscriptions
       set plan_key = p_plan_key,
           status = 'active',
           current_period_start = v_start,
           current_period_end = p_period_end,
           billing_updated_at = v_now,
           updated_at = v_now
     where id = v_existing.id
     returning * into v_row;
  else
    v_before := null;
    v_start := v_now;
    insert into saas_business.subscriptions(
      user_id, plan_key, status, billing_provider,
      external_customer_id, external_subscription_id,
      current_period_start, current_period_end, billing_updated_at
    ) values (
      p_user_id, p_plan_key, 'active', 'manual',
      null, 'manual:' || v_ref::text,
      v_start, p_period_end, v_now
    )
    returning * into v_row;
  end if;

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    v_actor, 'business_grow_subscription_set', 'user', p_user_id::text,
    jsonb_build_object(
      'subscription_id', v_row.id,
      'reference', v_row.external_subscription_id,
      'plan_key', p_plan_key,
      'period_start', v_start,
      'period_end', p_period_end,
      'note', v_note,
      'before', v_before,
      'after', to_jsonb(v_row)
    )
  );

  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (
    p_user_id,
    'Abonnement Business Grow activé',
    'Formule « ' || v_plan.display_name || ' » active jusqu''au '
      || to_char(p_period_end at time zone 'UTC', 'DD/MM/YYYY') || ' (UTC), attribuée par un administrateur.',
    'success',
    '/app/business/abonnement'
  );

  -- Preuve immédiate : le droit d'accès réel, calculé par la règle unique.
  v_access := saas_business.bg_import_access(p_user_id, v_now);

  return jsonb_build_object(
    'subscription_id', v_row.id,
    'user_id', v_row.user_id,
    'plan_key', v_row.plan_key,
    'status', v_row.status,
    'billing_provider', v_row.billing_provider,
    'reference', v_row.external_subscription_id,
    'current_period_start', v_row.current_period_start,
    'current_period_end', v_row.current_period_end,
    'renewed', v_before is not null,
    'access', v_access
  );
end
$function$;

comment on function public.vyora_admin_set_business_subscription(uuid, text, timestamptz, text) is
  'Administrateur uniquement : attribue/renouvelle manuellement une formule Business Grow à un compte client, avec date de fin (≤ 366 j). Journalisé. N''active aucune facturation.';

-- Résiliation d'une attribution manuelle (l'accès se ferme immédiatement :
-- `bg_import_access()` n'accepte que `active`/`trialing`).
create or replace function public.vyora_admin_revoke_business_subscription(
  p_user_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_existing saas_business.subscriptions%rowtype;
  v_row saas_business.subscriptions%rowtype;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  perform ugc_private.reelora_assert_admin();
  if p_user_id is null then raise exception 'target_required'; end if;

  select * into v_existing
    from saas_business.subscriptions s
   where s.user_id = p_user_id and s.billing_provider = 'manual'
     and s.status in ('active', 'trialing')
   order by s.created_at desc
   limit 1;
  if not found then raise exception 'manual_subscription_not_found'; end if;

  update saas_business.subscriptions
     set status = 'canceled', billing_updated_at = now(), updated_at = now()
   where id = v_existing.id
   returning * into v_row;

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    v_actor, 'business_grow_subscription_revoked', 'user', p_user_id::text,
    jsonb_build_object('subscription_id', v_row.id, 'note', v_note,
                       'before', to_jsonb(v_existing), 'after', to_jsonb(v_row))
  );

  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (p_user_id, 'Abonnement Business Grow résilié',
          'Votre formule Business Grow a été résiliée par un administrateur.',
          'warning', '/app/business/abonnement');

  return jsonb_build_object(
    'subscription_id', v_row.id, 'status', v_row.status,
    'access', saas_business.bg_import_access(p_user_id, now())
  );
end
$function$;

comment on function public.vyora_admin_revoke_business_subscription(uuid, text) is
  'Administrateur uniquement : résilie l''attribution manuelle Business Grow d''un compte. Journalisé.';

revoke all on function public.vyora_admin_set_business_subscription(uuid, text, timestamptz, text) from public, anon;
revoke all on function public.vyora_admin_revoke_business_subscription(uuid, text) from public, anon;
grant execute on function public.vyora_admin_set_business_subscription(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.vyora_admin_revoke_business_subscription(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4) `bg_import_access` : même règle, nom réel du produit
-- -----------------------------------------------------------------------------
create or replace function saas_business.bg_import_access(
  p_user_id uuid,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_sub saas_business.subscriptions%rowtype;
  v_plan_active boolean;
  v_trouve boolean := false;
  v_motif text;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'NOT_AUTHENTICATED',
      'message', 'Authentification requise.', 'checked_at', coalesce(p_at, now()));
  end if;

  select s.* into v_sub
    from saas_business.subscriptions s
   where s.user_id = p_user_id
     and s.status in ('active', 'trialing', 'past_due', 'expired', 'canceled')
   order by
     case s.status when 'active' then 0 when 'trialing' then 1 else 2 end,
     s.current_period_end desc nulls last,
     s.created_at desc
   limit 1;

  if not found then
    select exists(select 1 from saas_business.subscriptions s where s.user_id = p_user_id) into v_trouve;
    v_motif := case when v_trouve then 'SUBSCRIPTION_INACTIVE' else 'NO_SUBSCRIPTION' end;
    return jsonb_build_object('allowed', false, 'reason', v_motif,
      'message', case when v_trouve then 'Aucun abonnement Business Grow actif.'
        else 'Aucun abonnement Business Grow : souscription requise.' end,
      'status', null, 'plan_key', null, 'current_period_end', null,
      'checked_at', coalesce(p_at, now()));
  end if;

  if v_sub.status not in ('active', 'trialing') then
    v_motif := case v_sub.status when 'past_due' then 'PAYMENT_FAILED'
      when 'expired' then 'SUBSCRIPTION_EXPIRED' when 'canceled' then 'SUBSCRIPTION_CANCELED'
      else 'SUBSCRIPTION_INACTIVE' end;
    return jsonb_build_object('allowed', false, 'reason', v_motif,
      'message', case v_sub.status
        when 'past_due' then 'Le paiement de l’abonnement Business Grow a échoué ou est en retard.'
        when 'expired' then 'L’abonnement Business Grow a expiré.'
        when 'canceled' then 'L’abonnement Business Grow a été résilié.'
        else 'L’abonnement Business Grow n’est pas actif.' end,
      'status', v_sub.status, 'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end, 'checked_at', coalesce(p_at, now()));
  end if;

  if v_sub.current_period_end is null then
    return jsonb_build_object('allowed', false, 'reason', 'PERIOD_UNKNOWN',
      'message', 'La période de l’abonnement Business Grow n’est pas établie : accès refusé.',
      'status', v_sub.status, 'plan_key', v_sub.plan_key,
      'current_period_end', null, 'checked_at', coalesce(p_at, now()));
  end if;

  if v_sub.current_period_end <= coalesce(p_at, now()) then
    return jsonb_build_object('allowed', false, 'reason', 'SUBSCRIPTION_EXPIRED',
      'message', 'L’abonnement Business Grow a expiré.',
      'status', v_sub.status, 'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end, 'checked_at', coalesce(p_at, now()));
  end if;

  select p.active into v_plan_active from saas_business.plans p where p.plan_key = v_sub.plan_key;
  if v_plan_active is distinct from true then
    return jsonb_build_object('allowed', false, 'reason', 'PLAN_INACTIVE',
      'message', 'La formule Business Grow associée n’est plus disponible.',
      'status', v_sub.status, 'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end, 'checked_at', coalesce(p_at, now()));
  end if;

  return jsonb_build_object('allowed', true, 'reason', 'OK',
    'message', 'Abonnement Business Grow actif.',
    'status', v_sub.status, 'plan_key', v_sub.plan_key,
    'current_period_end', v_sub.current_period_end, 'checked_at', coalesce(p_at, now()));
end
$function$;

comment on function saas_business.bg_import_access(uuid, timestamptz) is
  'Source unique du droit d''accès à Import & Connect : abonnement Business Grow en cours (payé ou attribué par un administrateur), sur une formule active. Aucun identifiant client.';

-- -----------------------------------------------------------------------------
-- 5) Contrôles à l'application — sous-transactions annulées, aucune trace
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_admin uuid;
  v_client uuid;
  v_autre uuid;
  v_res jsonb;
  v_acc jsonb;
begin
  -- Droits : jamais `anon`, `authenticated` seulement (le rôle admin est revérifié dedans).
  if has_function_privilege('anon', 'public.vyora_admin_set_business_subscription(uuid, text, timestamptz, text)', 'execute') then
    raise exception 'anon ne doit pas exécuter vyora_admin_set_business_subscription';
  end if;
  if not has_function_privilege('authenticated', 'public.vyora_admin_set_business_subscription(uuid, text, timestamptz, text)', 'execute') then
    raise exception 'authenticated doit pouvoir appeler la RPC (refusée ensuite si non admin)';
  end if;

  -- Les formules sont proposées, mais restent non achetables.
  if (select count(*) from saas_business.plans where plan_key in ('essentiel','croissance','scale') and active) <> 3 then
    raise exception 'les trois formules doivent être actives';
  end if;
  if exists (select 1 from saas_business.plans where billing_enabled or monthly_price_minor is not null) then
    raise exception 'aucune formule ne doit être facturable ni tarifée par cette migration';
  end if;

  -- Un utilisateur sans abonnement reste refusé, avec le nouveau libellé.
  v_acc := saas_business.bg_import_access('00000000-0000-0000-0000-000000000000'::uuid, now());
  if (v_acc->>'allowed')::boolean is true or v_acc->>'reason' <> 'NO_SUBSCRIPTION' then
    raise exception 'NO_SUBSCRIPTION attendu, obtenu %', v_acc;
  end if;
  if position('Business Ground' in v_acc->>'message') > 0 then
    raise exception 'le libellé « Business Ground » subsiste : %', v_acc->>'message';
  end if;

  -- Scénarios complets, dans une sous-transaction toujours annulée.
  --
  -- L'administrateur est celui de la base (`ugc_user_roles_single_admin_idx`
  -- n'autorise qu'un seul rôle admin : on ne peut pas en créer un de test).
  -- Seules ses revendications JWT sont simulées ; les lignes de journal
  -- produites sont annulées avec le reste. Sans administrateur (base vierge),
  -- les scénarios sont ignorés avec un avertissement explicite.
  select r.user_id into v_admin from saas_ugc.ugc_user_roles r where r.role = 'admin' limit 1;
  if v_admin is null then
    raise warning 'business_grow_admin_subscription : aucun administrateur en base, scénarios RPC ignorés.';
    return;
  end if;
  begin
    -- Deux comptes clients de test (GoTrue minimal). Jamais conservés.
    v_client := gen_random_uuid(); v_autre := gen_random_uuid();
    insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                           raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                           confirmation_token, recovery_token, email_change_token_new, email_change)
    values
      (v_client, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'verif-client-' || v_client::text || '@example.invalid', 'x', now(), '{}', '{}', now(), now(), '', '', '', ''),
      (v_autre, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'verif-autre-' || v_autre::text || '@example.invalid', 'x', now(), '{}', '{}', now(), now(), '', '', '', '');
    insert into saas_ugc.ugc_customer_accounts(user_id) values (v_client), (v_autre)
      on conflict do nothing;

    -- (a) Non-administrateur : refusé.
    perform set_config('request.jwt.claims', json_build_object('sub', v_autre, 'role', 'authenticated')::text, true);
    begin
      perform public.vyora_admin_set_business_subscription(v_client, 'essentiel', now() + interval '30 days', 'test');
      raise exception 'verif: un non-administrateur a pu attribuer un abonnement';
    exception when others then
      if sqlerrm not in ('forbidden') then raise; end if;
    end;

    -- (b) Administrateur : attribution autorisée, accès ouvert, journal écrit.
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_res := public.vyora_admin_set_business_subscription(v_client, 'essentiel', now() + interval '30 days', 'activation de test');
    if v_res->>'status' <> 'active' or v_res->>'billing_provider' <> 'manual' or (v_res->'access'->>'allowed')::boolean is not true then
      raise exception 'verif: attribution admin invalide %', v_res;
    end if;
    if not exists (select 1 from saas_ugc.ugc_audit_logs
                    where actor_user_id = v_admin and action = 'business_grow_subscription_set' and target_id = v_client::text) then
      raise exception 'verif: journal d''audit absent';
    end if;

    -- (c) Isolation : l'autre compte n'a rien reçu.
    v_acc := saas_business.bg_import_access(v_autre, now());
    if (v_acc->>'allowed')::boolean is true or v_acc->>'reason' <> 'NO_SUBSCRIPTION' then
      raise exception 'verif: isolation rompue %', v_acc;
    end if;

    -- (d) Expiration : à J+31 l'accès est fermé, sans intervention.
    v_acc := saas_business.bg_import_access(v_client, now() + interval '31 days');
    if (v_acc->>'allowed')::boolean is true or v_acc->>'reason' <> 'SUBSCRIPTION_EXPIRED' then
      raise exception 'verif: expiration non appliquée %', v_acc;
    end if;

    -- (e) Renouvellement : même ligne mise à jour, nouvelle date, accès rouvert à J+31.
    v_res := public.vyora_admin_set_business_subscription(v_client, 'croissance', now() + interval '60 days', 'renouvellement');
    if (v_res->>'renewed')::boolean is not true or v_res->>'plan_key' <> 'croissance' then
      raise exception 'verif: renouvellement invalide %', v_res;
    end if;
    if (select count(*) from saas_business.subscriptions where user_id = v_client) <> 1 then
      raise exception 'verif: doublon d''abonnement manuel';
    end if;
    v_acc := saas_business.bg_import_access(v_client, now() + interval '31 days');
    if (v_acc->>'allowed')::boolean is not true then raise exception 'verif: renouvellement sans effet %', v_acc; end if;

    -- (f) Garde-fous : date passée, trop lointaine, formule inconnue, cible admin, auto-attribution.
    begin
      perform public.vyora_admin_set_business_subscription(v_client, 'essentiel', now() - interval '1 day', null);
      raise exception 'verif: date passée acceptée';
    exception when others then if sqlerrm <> 'period_end_must_be_future' then raise; end if; end;
    begin
      perform public.vyora_admin_set_business_subscription(v_client, 'essentiel', now() + interval '400 days', null);
      raise exception 'verif: date trop lointaine acceptée';
    exception when others then if sqlerrm <> 'period_end_too_far' then raise; end if; end;
    begin
      perform public.vyora_admin_set_business_subscription(v_client, 'inexistante', now() + interval '10 days', null);
      raise exception 'verif: formule inconnue acceptée';
    exception when others then if sqlerrm <> 'plan_not_found' then raise; end if; end;
    begin
      perform public.vyora_admin_set_business_subscription(v_admin, 'essentiel', now() + interval '10 days', null);
      raise exception 'verif: auto-attribution acceptée';
    exception when others then if sqlerrm <> 'self_assignment_forbidden' then raise; end if; end;
    -- Compte inconnu : refusé avant toute écriture.
    begin
      perform public.vyora_admin_set_business_subscription(gen_random_uuid(), 'essentiel', now() + interval '10 days', null);
      raise exception 'verif: compte inconnu accepté';
    exception when others then if sqlerrm <> 'target_not_found' then raise; end if; end;

    -- (g) Paiement en retard : un abonnement `past_due` ferme l'accès (PAYMENT_FAILED).
    update saas_business.subscriptions set status = 'past_due' where user_id = v_client;
    v_acc := saas_business.bg_import_access(v_client, now());
    if (v_acc->>'allowed')::boolean is true or v_acc->>'reason' <> 'PAYMENT_FAILED' then
      raise exception 'verif: past_due non appliqué %', v_acc;
    end if;
    update saas_business.subscriptions set status = 'active' where user_id = v_client;

    -- (h) Résiliation par l'administrateur : accès fermé immédiatement.
    v_res := public.vyora_admin_revoke_business_subscription(v_client, 'fin de test');
    if v_res->>'status' <> 'canceled' or (v_res->'access'->>'allowed')::boolean is true
       or v_res->'access'->>'reason' <> 'SUBSCRIPTION_CANCELED' then
      raise exception 'verif: résiliation invalide %', v_res;
    end if;

    -- (i) Aucun libellé « Business Ground » dans les messages produits.
    if position('Business Ground' in v_res->'access'->>'message') > 0 then
      raise exception 'verif: libellé Business Ground subsiste';
    end if;

    -- Tout annuler : aucun compte, abonnement, journal ou notification de test ne reste.
    raise exception 'verif_rollback_ok';
  exception when others then
    if sqlerrm <> 'verif_rollback_ok' then
      raise exception 'contrôle de migration échoué : % (%)', sqlerrm, sqlstate;
    end if;
  end;

  raise notice 'business_grow_admin_subscription : contrôles passés (sous-transaction annulée).';
end
$verif$;
