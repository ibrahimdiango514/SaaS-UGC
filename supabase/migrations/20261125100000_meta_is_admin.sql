-- VYORA — parcours WhatsApp de TEST : décision d'administrateur.
--
-- ## Pourquoi cette migration
--
-- Le parcours de test attache une connexion WhatsApp SANS échange OAuth. C'est
-- la seule entorse du code au modèle « un jeton vient d'une autorisation ».
-- La décision « cette personne est-elle l'administrateur propriétaire ? » doit
-- donc être prise là où un client ne peut pas l'influencer : en base, à partir
-- de l'identifiant GoTrue vérifié côté Edge.
--
-- Pourquoi une fonction et pas une requête en ligne dans la fonction Edge :
--   * `saas_ugc.ugc_user_roles` n'est pas exposée aux rôles `anon`/
--     `authenticated` ; la fonction Edge y accède avec la clé de service, mais
--     centraliser la règle évite qu'elle diverge d'un appel à l'autre ;
--   * la règle est ainsi lisible, testable et modifiable sans redéployer une
--     fonction Edge ;
--   * `security definer` + `search_path = ''` : aucune injection de schéma.
--
-- ## Portée
-- Lecture seule. Aucune table créée, aucune ligne écrite, aucune donnée
-- existante modifiée. Réexécutable sans effet de bord.
--
-- ## Retour arrière
--   drop function if exists saas_business.meta_is_admin(uuid);
-- Aucun impact sur le parcours client : il n'appelle pas cette fonction.

create or replace function saas_business.meta_is_admin(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  /*
   * L'administrateur est unique par construction : l'index partiel
   * `ugc_user_roles_single_admin_idx` garantit au plus une ligne `admin`.
   * On interroge donc le rôle directement, sans liste d'e-mails en dur ni
   * variable d'environnement — une variable d'environnement se modifie par
   * erreur, une ligne de rôle se modifie par décision.
   */
  select exists (
    select 1
    from saas_ugc.ugc_user_roles r
    where r.user_id = p_user_id
      and r.role = 'admin'
  );
$$;

comment on function saas_business.meta_is_admin(uuid) is
  'Vrai si p_user_id porte le rôle admin (administrateur propriétaire VYORA). Utilisé uniquement pour réserver le parcours WhatsApp de test ; le parcours client ne l''appelle pas.';

-- Un client authentifié ne doit pas pouvoir s'auto-attribuer le parcours :
-- la fonction est réservée à la clé de service (fonctions Edge).
revoke all on function saas_business.meta_is_admin(uuid) from public;
revoke all on function saas_business.meta_is_admin(uuid) from anon;
revoke all on function saas_business.meta_is_admin(uuid) from authenticated;
