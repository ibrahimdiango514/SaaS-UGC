-- IMPORT & CONNECT — contrôle d'accès centralisé aux droits Business Ground.
--
-- ## Règle unique, et pourquoi elle est en base
-- Import & Connect est réservé aux abonnements Business Ground **payés et
-- actifs**. Masquer un bouton ne protège rien : la décision doit être prise là
-- où les données d'abonnement vivent, une seule fois, et être appelée par
-- CHAQUE point d'entrée serveur (Edge Functions comprises).
--
-- Ce module NE crée aucun second système d'abonnement. Il lit
-- `saas_business.subscriptions` et `saas_business.plans`, déjà existants, et
-- n'écrit jamais dedans.
--
-- ## Ce que « actif » signifie ici
-- Un accès est accordé seulement si TOUTES les conditions sont vraies :
--   1. le statut est `active` (ou `trialing`, essai accordé par le serveur) —
--      donc `past_due`, `canceled`, `expired`, `pending_integration` échouent ;
--   2. la période est en cours : `current_period_end` est renseignée ET
--      strictement postérieure à l'instant de la vérification ;
--   3. la formule elle-même est encore commercialisée (`plans.active`).
-- Un abonnement sans date de fin est traité comme NON valable : c'est le cas
-- d'une souscription dont le paiement n'a jamais été appliqué, et il ne doit pas
-- ouvrir l'accès par omission.
--
-- ## Pourquoi un instant injectable
-- Toute la logique dépend de `now()`. La fonction accepte `p_at` pour que la
-- règle « l'abonnement expire pendant la session » soit réellement testable
-- (on avance l'horloge au lieu d'attendre). En production, l'appelant omet le
-- paramètre et c'est `now()` qui décide.
--
-- ## Isolation
-- Toutes les fonctions sont `SECURITY DEFINER`, `search_path = ''`, et
-- n'acceptent AUCUN identifiant fourni par le client : elles ne regardent que
-- `auth.uid()` (ou l'utilisateur passé par un appelant serveur déjà authentifié
-- par GoTrue). Un utilisateur ne peut donc pas interroger les droits d'un autre.

-- -----------------------------------------------------------------------------
-- 1) La règle pure, sur un utilisateur donné.
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
  v_allowed boolean := false;
begin
  if p_user_id is null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'NOT_AUTHENTICATED',
      'message', 'Authentification requise.',
      'checked_at', coalesce(p_at, now())
    );
  end if;

  -- On retient l'abonnement le PLUS favorable encore ouvert : un utilisateur
  -- peut avoir un historique (expiré) et un abonnement courant. On ne prend
  -- jamais un ancien abonnement expiré pour refuser un accès valide.
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
    -- Aucun abonnement : on distingue clairement « jamais souscrit ».
    select exists(
      select 1 from saas_business.subscriptions s where s.user_id = p_user_id
    ) into v_trouve;
    v_motif := case when v_trouve then 'SUBSCRIPTION_INACTIVE' else 'NO_SUBSCRIPTION' end;
    return jsonb_build_object(
      'allowed', false,
      'reason', v_motif,
      'message', case when v_trouve
        then 'Aucun abonnement Business Ground actif.'
        else 'Aucun abonnement Business Ground : souscription requise.' end,
      'status', null,
      'plan_key', null,
      'current_period_end', null,
      'checked_at', coalesce(p_at, now())
    );
  end if;

  -- Statut : seuls `active` et `trialing` ouvrent l'accès.
  if v_sub.status not in ('active', 'trialing') then
    v_motif := case v_sub.status
      when 'past_due' then 'PAYMENT_FAILED'
      when 'expired' then 'SUBSCRIPTION_EXPIRED'
      when 'canceled' then 'SUBSCRIPTION_CANCELED'
      else 'SUBSCRIPTION_INACTIVE' end;
    return jsonb_build_object(
      'allowed', false,
      'reason', v_motif,
      'message', case v_sub.status
        when 'past_due' then 'Le paiement de l’abonnement Business Ground a échoué ou est en retard.'
        when 'expired' then 'L’abonnement Business Ground a expiré.'
        when 'canceled' then 'L’abonnement Business Ground a été résilié.'
        else 'L’abonnement Business Ground n’est pas actif.' end,
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end,
      'checked_at', coalesce(p_at, now())
    );
  end if;

  -- Période : une date de fin absente ou passée ferme l'accès. Une session
  -- ouverte ne survit donc pas à l'expiration : chaque opération revérifie.
  if v_sub.current_period_end is null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'PERIOD_UNKNOWN',
      'message', 'La période de l’abonnement Business Ground n’est pas établie : accès refusé.',
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_end', null,
      'checked_at', coalesce(p_at, now())
    );
  end if;

  if v_sub.current_period_end <= coalesce(p_at, now()) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'SUBSCRIPTION_EXPIRED',
      'message', 'L’abonnement Business Ground a expiré.',
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end,
      'checked_at', coalesce(p_at, now())
    );
  end if;

  -- La formule doit encore être commercialisée : une formule retirée ne doit
  -- plus ouvrir l'accès, même à un abonné historiquement valide.
  select p.active into v_plan_active
    from saas_business.plans p where p.plan_key = v_sub.plan_key;
  if v_plan_active is distinct from true then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'PLAN_INACTIVE',
      'message', 'La formule Business Ground associée n’est plus disponible.',
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_end', v_sub.current_period_end,
      'checked_at', coalesce(p_at, now())
    );
  end if;

  v_allowed := true;
  return jsonb_build_object(
    'allowed', v_allowed,
    'reason', 'OK',
    'message', 'Abonnement Business Ground actif.',
    'status', v_sub.status,
    'plan_key', v_sub.plan_key,
    'current_period_end', v_sub.current_period_end,
    'checked_at', coalesce(p_at, now())
  );
end
$function$;

comment on function saas_business.bg_import_access(uuid, timestamptz) is
  'Source unique du droit d''accès à Import & Connect : abonnement Business Ground payé, en cours, sur une formule active. Aucun identifiant client.';

-- -----------------------------------------------------------------------------
-- 2) Version « appelant » : ne regarde QUE la session. C'est ce qu'utilise le
--    navigateur, et ce qu'aucun client ne peut détourner (pas d'argument).
-- -----------------------------------------------------------------------------
create or replace function public.vyora_import_connect_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'NOT_AUTHENTICATED',
      'message', 'Authentification requise.',
      'checked_at', now()
    );
  end if;
  return saas_business.bg_import_access(v_user, now());
end
$function$;

comment on function public.vyora_import_connect_access() is
  'Droits Import & Connect de l''utilisateur connecté. Ne prend aucun argument : impossible de sonder les droits d''un autre compte.';

-- -----------------------------------------------------------------------------
-- 3) Garde d'exécution : lève si l'accès n'est pas accordé.
--    Les fonctions métier l'appellent en PREMIÈRE instruction, ce qui rend la
--    vérification impossible à oublier sur une nouvelle opération.
-- -----------------------------------------------------------------------------
create or replace function saas_business.bg_require_import_access(
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
  v_droits jsonb;
begin
  v_droits := saas_business.bg_import_access(p_user_id, p_at);
  if (v_droits->>'allowed')::boolean is not true then
    -- 42501 = insufficient_privilege. Le code et le motif sont conservés pour
    -- que l'appelant puisse répondre précisément (abonnement expiré, paiement
    -- en échec, aucun abonnement…) sans jamais s'appuyer sur le client.
    raise exception 'import_connect_forbidden:%', v_droits->>'reason'
      using errcode = '42501',
            hint = v_droits->>'message',
            detail = v_droits::text;
  end if;
  return v_droits;
end
$function$;

comment on function saas_business.bg_require_import_access(uuid, timestamptz) is
  'Garde d''exécution : refuse toute opération Import & Connect sans abonnement Business Ground valide (42501).';

-- -----------------------------------------------------------------------------
-- 4) Droits d'exécution : `authenticated` seulement. Aucun accès anonyme.
-- -----------------------------------------------------------------------------
revoke all on function saas_business.bg_import_access(uuid, timestamptz) from public, anon;
revoke all on function public.vyora_import_connect_access() from public, anon;
revoke all on function saas_business.bg_require_import_access(uuid, timestamptz) from public, anon;

grant execute on function public.vyora_import_connect_access() to authenticated;

-- `bg_import_access` et `bg_require_import_access` ne sont PAS données à
-- `authenticated` : elles prennent un identifiant d'utilisateur. Seul le rôle
-- `service_role` (Edge Functions, déjà authentifiées par GoTrue) les exécute,
-- ce qui empêche un client de sonder l'abonnement d'un autre compte.
grant execute on function saas_business.bg_import_access(uuid, timestamptz) to service_role;
grant execute on function saas_business.bg_require_import_access(uuid, timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- 5) Contrôles de non-régression, exécutés à l'application de la migration.
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_anon boolean;
  v_auth boolean;
  v_svc boolean;
  v_def jsonb;
begin
  -- `anon` ne doit exécuter AUCUNE des trois fonctions.
  select has_function_privilege('anon', 'public.vyora_import_connect_access()', 'execute')
    into v_anon;
  if v_anon then
    raise exception 'anon peut exécuter vyora_import_connect_access : interdit';
  end if;

  -- `authenticated` ne doit exécuter QUE la version sans argument.
  select has_function_privilege('authenticated', 'public.vyora_import_connect_access()', 'execute')
    into v_auth;
  if not v_auth then
    raise exception 'authenticated doit pouvoir lire ses propres droits';
  end if;

  select has_function_privilege('authenticated',
    'saas_business.bg_import_access(uuid, timestamptz)', 'execute') into v_auth;
  if v_auth then
    raise exception 'authenticated ne doit pas pouvoir sonder les droits d''un autre utilisateur';
  end if;

  select has_function_privilege('service_role',
    'saas_business.bg_import_access(uuid, timestamptz)', 'execute') into v_svc;
  if not v_svc then
    raise exception 'service_role doit pouvoir vérifier les droits côté serveur';
  end if;

  -- Un utilisateur inexistant n'obtient jamais l'accès (règle par défaut sûre).
  v_def := saas_business.bg_import_access('00000000-0000-0000-0000-000000000000'::uuid, now());
  if (v_def->>'allowed')::boolean is true then
    raise exception 'un utilisateur sans abonnement obtient l''accès : interdit';
  end if;
  if v_def->>'reason' <> 'NO_SUBSCRIPTION' then
    raise exception 'motif attendu NO_SUBSCRIPTION, obtenu %', v_def->>'reason';
  end if;
end
$verif$;
