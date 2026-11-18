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
-- Aucune donnée personnelle n'est journalisée ici : on n'écrit que des
-- horodatages et des codes opaques.
-- =============================================================================

begin;

-- 1) Journal des demandes de suppression, pour pouvoir répondre au suivi.
--    La personne reçoit un code de confirmation ; ce journal permet de lui dire
--    où en est sa demande sans exposer d'identifiant Meta.
create table if not exists saas_business.meta_deletion_requests (
  id                uuid primary key default gen_random_uuid(),
  -- Identifiant applicatif Meta (ASID) : sert uniquement à la corrélation.
  meta_user_id      text not null,
  confirmation_code text not null unique,
  status            text not null default 'pending'
                    check (status in ('pending', 'completed', 'no_data')),
  -- Nombre de connexions effectivement supprimées (0 si l'utilisateur n'était
  -- pas client VYORA : cas légitime, à ne pas traiter comme une erreur).
  connections_removed integer not null default 0,
  requested_at      timestamptz not null default now(),
  completed_at      timestamptz
);
create index if not exists meta_deletion_requests_user_idx
  on saas_business.meta_deletion_requests (meta_user_id, requested_at desc);
alter table saas_business.meta_deletion_requests enable row level security;
alter table saas_business.meta_deletion_requests force row level security;
revoke all on saas_business.meta_deletion_requests from anon, authenticated;

-- 2) Révoque toutes les connexions d'un utilisateur Meta (dé-autorisation).
--
--    Périmètre volontairement limité aux jetons d'UTILISATEUR, parce que c'est
--    ce que signifie le rappel : la personne a retiré l'application de son
--    compte Facebook. Les jetons SYSTÈME WhatsApp (Embedded Signup) ne sont pas
--    des autorisations d'utilisateur ; ils appartiennent au portefeuille
--    Business du client et restent valides après un retrait côté profil
--    personnel. Les supprimer ici couperait une messagerie en production sans
--    motif — le client n'a pas demandé cela.
--
--    Renvoie les noms de secrets Vault à effacer, pour que la fonction ne
--    laisse aucun jeton orphelin.
create or replace function saas_business.meta_revoke_user_connections(p_meta_user_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_refs text[]; v_count integer := 0;
begin
  -- Jetons de page d'abord (référencés par meta_pages).
  select array_agg(p.token_ref) filter (where p.token_ref is not null) into v_refs
    from saas_business.meta_pages p
    join saas_business.meta_connections c on c.id = p.connection_id
   where c.external_account_id = p_meta_user_id
     and c.product in ('facebook', 'messenger', 'instagram');

  -- Puis le jeton utilisateur de chaque connexion concernée, EN AJOUTANT aux
  -- références de page déjà collectées. Un `array_agg` seul écraserait
  -- silencieusement `v_refs` et laisserait des jetons de page orphelins.
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

  return jsonb_build_object(
    'removed', v_count,
    'token_refs', to_jsonb(coalesce(v_refs, '{}'::text[]))
  );
end $$;

-- 3) Suppression de données : efface tout ce que VYORA détient pour cet
--    utilisateur Meta, tous produits confondus.
--
--    Cette fois, WhatsApp est inclus : une demande de suppression de données
--    n'est pas une simple révocation d'autorisation, c'est une obligation de
--    droit (RGPD et équivalents). On efface aussi les messages et événements
--    de page, qui contiennent du contenu de tiers.
--
--    NOTE IMPORTANTE : les jetons système WhatsApp ne peuvent pas être
--    « révoqués » par un appel API — Meta n'expose pas cette opération pour un
--    jeton système. On les EFFACE de Vault, ce qui les rend inutilisables.
--    C'est le comportement correct : la donnée de VYORA disparaît.
create or replace function saas_business.meta_delete_user_data(p_meta_user_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_refs text[]; v_conns integer := 0; v_msgs integer := 0; v_events integer := 0;
begin
  select coalesce(array_agg(p.token_ref) filter (where p.token_ref is not null), '{}'::text[]) into v_refs
    from saas_business.meta_pages p
    join saas_business.meta_connections c on c.id = p.connection_id
   where c.external_account_id = p_meta_user_id;

  select coalesce(v_refs, '{}'::text[])
         || coalesce(array_agg(c.token_ref) filter (where c.token_ref is not null), '{}'::text[])
    into v_refs
    from saas_business.meta_connections c
   where c.external_account_id = p_meta_user_id;
  -- Contenus reçus, rattachés à CES connexions précises.
  --
  -- Le rattachement se fait par connection_id / page_id, jamais par
  -- workspace_id : un espace de travail peut réunir plusieurs clients, chacun
  -- avec sa propre connexion. Supprimer « tout le workspace » effacerait les
  -- messages d'un tiers qui n'a rien demandé.
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

  return jsonb_build_object(
    'connections_removed', v_conns,
    'messages_removed', v_msgs,
    'page_events_removed', v_events,
    'token_refs', to_jsonb(coalesce(v_refs, '{}'::text[]))
  );
end $$;

-- 4) Enregistre la demande de suppression et renvoie le code de confirmation.
create or replace function saas_business.meta_deletion_record(
  p_meta_user_id text,
  p_confirmation_code text,
  p_connections_removed integer
)
returns void
language sql security definer set search_path = '' as $$
  insert into saas_business.meta_deletion_requests
    (meta_user_id, confirmation_code, status, connections_removed, completed_at)
  values (p_meta_user_id, p_confirmation_code,
          case when p_connections_removed > 0 then 'completed' else 'no_data' end,
          p_connections_removed, now())
  on conflict (confirmation_code) do nothing;
$$;

revoke all on function saas_business.meta_revoke_user_connections(text) from public, anon, authenticated;
revoke all on function saas_business.meta_delete_user_data(text) from public, anon, authenticated;
revoke all on function saas_business.meta_deletion_record(text, text, integer) from public, anon, authenticated;

commit;
