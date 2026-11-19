-- =============================================================================
-- VYORA — rappels de cycle de vie des autorisations Meta
-- =============================================================================
-- Un client peut retirer VYORA depuis Facebook, ou demander la suppression de
-- ses données, SANS jamais repasser par VYORA. Meta prévient alors
-- l'application sur une URL publique, par un POST signé (voir
-- src/business/meta/deauthorize.ts pour la vérification de signature).
--
-- Sans ces deux points d'entrée :
--   1. une connexion révoquée continue d'afficher « Connecté » et VYORA garde
--      des jetons morts dans Vault ;
--   2. Meta peut désactiver le rappel de suppression de données, puis
--      suspendre l'application — c'est une obligation des Platform Terms.
--
-- ## Trois exigences de conception
--
-- a) **ATOMICITÉ.** La suppression des données et l'écriture de la demande de
--    suivi se font dans la MÊME fonction, donc la même transaction. Deux appels
--    séparés permettraient de supprimer les données puis d'échouer sur
--    l'enregistrement : des données détruites sans preuve vérifiable.
--
-- b) **IDEMPOTENCE.** Un rappel rejoué (nouvelle tentative réseau de Meta) ne
--    doit ni échouer, ni créer de doublon ambigu, ni viser un autre utilisateur.
--    Le pire cas est de re-préfixer son PROPRE identifiant Meta.
--
-- c) **CODE NON CHOISI PAR L'APPELANT.** Le code de confirmation est calculé
--    ici. S'il venait de la requête, un appelant pourrait fournir un code déjà
--    utilisé et écraser la demande d'un tiers.
--
-- Aucune donnée personnelle n'est journalisée : que des horodatages, des
-- compteurs et des codes opaques.
-- =============================================================================

begin;

-- 1) Journal des demandes de suppression, pour pouvoir répondre au suivi.
--
--    La personne reçoit un code de confirmation ; ce journal permet de lui dire
--    où en est sa demande sans exposer d'identifiant Meta.
--    `failed_at` distingue une tentative qui n'a pas abouti d'une demande
--    simplement encore en cours.
create table if not exists saas_business.meta_deletion_requests (
  id                uuid primary key default gen_random_uuid(),
  -- Identifiant applicatif Meta (ASID) : sert uniquement à la corrélation.
  meta_user_id      text not null,
  confirmation_code text not null unique,
  status            text not null default 'pending'
                    check (status in ('pending', 'completed', 'no_data')),
  -- Nombre de connexions effectivement supprimées (0 si la personne n'était pas
  -- cliente : cas légitime, à ne pas traiter comme une erreur).
  connections_removed integer not null default 0,
  requested_at      timestamptz not null default now(),
  completed_at      timestamptz,
  failed_at         timestamptz
);
create index if not exists meta_deletion_requests_user_idx
  on saas_business.meta_deletion_requests (meta_user_id, requested_at desc);
alter table saas_business.meta_deletion_requests enable row level security;
alter table saas_business.meta_deletion_requests force row level security;
revoke all on saas_business.meta_deletion_requests from anon, authenticated;

-- 2) RÉVOCATION (déautorisation) : toutes les connexions Login for Business,
--    Pages et Instagram de l'identité concernée.
--
--    WhatsApp est volontairement EXCLU.
--
--    Les jetons WhatsApp proviennent de l'Embedded Signup : ce sont des jetons
--    SYSTÈME attachés au portefeuille Business du client, pas des autorisations
--    du profil Facebook personnel. Retirer VYORA de son profil personnel ne les
--    invalide pas et n'exprime aucune intention de couper la messagerie. Les
--    effacer ici interromprait un service en production pour une action qui ne
--    le visait pas.
--
--    Le rappel `data-deletion` (plus bas), lui, supprime tout : c'est une
--    demande explicite de suppression de données.
--
--    Idempotence : une seconde exécution ne trouve plus rien à supprimer,
--    renvoie `removed = 0` et n'échoue pas.
create or replace function saas_business.meta_revoke_user_connections(p_meta_user_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_refs text[]; v_count integer := 0;
begin
  -- Jetons de page…
  select coalesce(array_agg(p.token_ref) filter (where p.token_ref is not null), '{}'::text[])
    into v_refs
    from saas_business.meta_pages p
    join saas_business.meta_connections c on c.id = p.connection_id
   where c.external_account_id = p_meta_user_id
     and c.product in ('facebook', 'messenger', 'instagram');

  -- …puis jetons de connexion, AJOUTÉS. Un `array_agg` seul écraserait le
  -- premier lot et laisserait des jetons de page orphelins dans Vault.
  select coalesce(v_refs, '{}'::text[])
         || coalesce(array_agg(c.token_ref) filter (where c.token_ref is not null), '{}'::text[])
    into v_refs
    from saas_business.meta_connections c
   where c.external_account_id = p_meta_user_id
     and c.product in ('facebook', 'messenger', 'instagram');

  delete from saas_business.meta_connections c
   where c.external_account_id = p_meta_user_id
     and c.product in ('facebook', 'messenger', 'instagram');
  get diagnostics v_count = row_count;

  -- Jetons hors de Vault, dans la même transaction : un secret orphelin serait
  -- un accès encore utilisable pour une autorisation qu'on dit révoquée.
  if array_length(v_refs, 1) is not null then
    delete from vault.secrets s where s.name = any(v_refs);
  end if;

  return jsonb_build_object(
    'removed', v_count,
    'token_refs', to_jsonb(coalesce(v_refs, '{}'::text[]))
  );
end $$;

-- 3) SUPPRESSION DE DONNÉES : tout effacer, et en garder la preuve.
--
--    Une demande de suppression n'est pas une simple révocation d'autorisation :
--    c'est une obligation de droit (RGPD et équivalents). WhatsApp est donc
--    inclus ici.
--
--    NOTE : Meta n'expose aucune API de révocation pour un jeton SYSTÈME. On les
--    EFFACE de Vault, ce qui les rend inutilisables. C'est le comportement
--    correct : la donnée de VYORA disparaît.
--
--    Périmètre des contenus : uniquement les lignes rattachées à CES connexions.
--    Le rattachement se fait par `connection_id` / `page_id`, JAMAIS par
--    `workspace_id` : un espace de travail peut réunir plusieurs clients, et
--    effacer « tout le workspace » détruirait les messages d'un tiers.
--
--    Inclut l'écriture de la demande de suivi (atomicité).
create or replace function saas_business.meta_delete_user_data(p_meta_user_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_refs text[];
  v_conns integer := 0;
  v_msgs integer := 0;
  v_events integer := 0;
  v_code text;
  v_status text;
begin
  select coalesce(array_agg(p.token_ref) filter (where p.token_ref is not null), '{}'::text[])
    into v_refs
    from saas_business.meta_pages p
    join saas_business.meta_connections c on c.id = p.connection_id
   where c.external_account_id = p_meta_user_id;

  select coalesce(v_refs, '{}'::text[])
         || coalesce(array_agg(c.token_ref) filter (where c.token_ref is not null), '{}'::text[])
    into v_refs
    from saas_business.meta_connections c
   where c.external_account_id = p_meta_user_id;

  delete from saas_business.meta_messages m
   where m.connection_id in (
     select c.id from saas_business.meta_connections c
      where c.external_account_id = p_meta_user_id
   );
  get diagnostics v_msgs = row_count;

  delete from saas_business.meta_page_events e
   where e.page_id in (
     select p.page_id
       from saas_business.meta_pages p
       join saas_business.meta_connections c on c.id = p.connection_id
      where c.external_account_id = p_meta_user_id
   );
  get diagnostics v_events = row_count;

  delete from saas_business.meta_connections c
   where c.external_account_id = p_meta_user_id;
  get diagnostics v_conns = row_count;

  if array_length(v_refs, 1) is not null then
    delete from vault.secrets s where s.name = any(v_refs);
  end if;

  /*
   * Code de confirmation CALCULÉ ICI, jamais fourni par l'appelant.
   *
   * 32 caractères hexadécimaux aléatoires : non énumérables.
   *
   * AUCUN fragment de l'identifiant Meta n'y figure. Une première version
   * gardait les 6 derniers caractères de l'ASID « pour le support » — vérifié
   * en base : le code devenait `vyora-WABA_1-…`, donc un identifiant Meta en
   * clair dans une URL publique, indexable et recopiable. Le support retrouve
   * une demande par le code (colonne `meta_user_id` en base), jamais en lisant
   * le code.
   */
  v_code := 'vyora-' || replace(gen_random_uuid()::text, '-', '');
  v_status := case when v_conns > 0 then 'completed' else 'no_data' end;

  insert into saas_business.meta_deletion_requests
    (meta_user_id, confirmation_code, status, connections_removed, completed_at)
  values (p_meta_user_id, v_code, v_status, v_conns, now());

  return jsonb_build_object(
    'confirmation_code', v_code,
    'status', v_status,
    'connections_removed', v_conns,
    'messages_removed', v_msgs,
    'page_events_removed', v_events
  );
end $$;

-- 4) LECTURE PUBLIQUE, par code de confirmation uniquement.
--
--    La page de suivi est publique — c'est exactement ce que Meta exige : « une
--    URL où la personne peut suivre l'état de sa demande ». Cette fonction est
--    donc exécutable par `anon`, et c'est précisément pour cela qu'elle ne rend
--    QUE quatre champs.
--
--    Elle ne renvoie jamais : l'identifiant Meta, l'adresse e-mail du client, un
--    jeton, un identifiant de Page ou de numéro. Sans code valide, elle ne
--    répond rien (`null`) — on ne peut pas énumérer les demandes.
create or replace function saas_business.meta_deletion_status(p_confirmation_code text)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select jsonb_build_object(
    'status', d.status,
    'requested_at', d.requested_at,
    'completed_at', d.completed_at,
    'has_failure', d.failed_at is not null
  )
  from saas_business.meta_deletion_requests d
  where d.confirmation_code = p_confirmation_code
  limit 1;
$$;

revoke all on function saas_business.meta_revoke_user_connections(text) from public, anon, authenticated;
revoke all on function saas_business.meta_delete_user_data(text) from public, anon, authenticated;
grant execute on function saas_business.meta_deletion_status(text) to anon, authenticated;

commit;
