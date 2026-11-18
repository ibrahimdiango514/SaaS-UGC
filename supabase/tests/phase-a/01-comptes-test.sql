-- Protocole de vérification Phase A en production — comptes isolés.
--
-- ## Pourquoi ce fichier
-- La Phase A ne peut pas être déclarée active sur la foi d'un `get_edge_function`.
-- Il faut prouver, par de vrais appels HTTP authentifiés, qu'un compte SANS
-- abonnement admissible est refusé et qu'un compte AVEC abonnement passe. Le
-- poste de développement n'a aucun accès réseau à Supabase ; la base, si
-- (`pg_net`). Les appels partent donc d'ici, contre l'URL publique du projet.
--
-- ## Garanties
--  * Comptes strictement isolés : domaine `@vyora-test.invalid` (jamais routable),
--    préfixe `phasea-`, et refus de réutiliser tout compte existant.
--  * Aucune donnée cliente touchée : les abonnements créés portent l'identifiant
--    de test `phasea-…` et sont supprimés avec les comptes.
--  * Tout est supprimable : `99-phasea-teardown` (fichier séparé).
--  * Authentification sans mot de passe partagé : le script tire un secret
--    aléatoire de 32 octets, en conserve l'empreinte bcrypt dans `auth.users`,
--    et n'affiche QUE ce secret dans le résultat de cette exécution unique. Il
--    est immédiatement remplacé (tourniquet, fichier 03) après obtention des
--    jetons, donc le secret affiché ne sert plus à rien ensuite.
--    Pourquoi ce détour : `auth.admin.generateLink` exige la clé de service,
--    que ce poste ne peut pas lire (les secrets du projet sont hachés côté API).
--    Le service role n'est donc jamais copié hors de la plateforme.
--
-- ## Ordre d'exécution
--   01 (ce fichier) → 02 (abonnement) → 03 (expiration) → 04 (appels) → 99 (nettoyage)

set search_path = public;

-- 0. Table de travail strictement privée, supprimée au nettoyage.
create table if not exists public.phasea_identifiants (
  email text primary key,
  mot_de_passe text not null,
  cree_le timestamptz not null default now()
);
-- Aucun rôle client ne doit voir ceci : c'est un secret d'authentification.
revoke all on public.phasea_identifiants from public, anon, authenticated;
alter table public.phasea_identifiants enable row level security;

-- 1. Garde-fou : ne jamais écraser un compte existant.
do $$
begin
  if exists (select 1 from auth.users where email like '%@vyora-test.invalid') then
    raise exception 'comptes de test Phase A déjà présents : exécuter 99-phasea-teardown avant de recréer';
  end if;
end $$;

-- 2. Deux comptes : A sans abonnement, B avec abonnement admissible.
do $$
declare
  compte record;
  uid uuid;
  secret text;
begin
  for compte in
    select * from (values
      ('phasea-a@vyora-test.invalid', 'Phase A — compte A (sans abonnement)'),
      ('phasea-b@vyora-test.invalid', 'Phase A — compte B (abonnement actif)')
    ) as t(email, libelle)
  loop
    -- `crypt` + `gen_salt` : mot de passe aléatoire que PERSONNE ne connaît,
    -- y compris ce script. Il n'est jamais affiché ni conservé ; la connexion
    -- se fera par lien magique généré à la demande.
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) values (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated', compte.email,
      extensions.crypt(secret, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', compte.libelle),
      false
    ) returning id into uid;

    -- Mémorisé le temps de la connexion, jamais stocké ailleurs.
    insert into phasea_identifiants (email, mot_de_passe)
    values (compte.email, secret)
    on conflict (email) do update set mot_de_passe = excluded.mot_de_passe;

    -- Identité e-mail : sans elle, GoTrue refuse la connexion.
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid, uid::text, 'email',
      jsonb_build_object('sub', uid::text, 'email', compte.email, 'email_verified', true),
      now(), now(), now()
    );
  end loop;
end $$;

-- 3. Résultat : identité du compte et secret d'amorçage (usage unique).
--    Rien d'autre n'est divulgué : ni empreinte, ni jeton, ni identifiant de
--    session. Le mot de passe affiché sera invalidé par `03-tourniquet.sql`.
select
  u.email,
  u.id as user_id,
  u.email_confirmed_at is not null as confirmé,
  (select count(*) from auth.identities i where i.user_id = u.id) as identités,
  i.mot_de_passe as amorçage
from auth.users u
join public.phasea_identifiants i on i.email = u.email
where u.email like '%@vyora-test.invalid'
order by u.email;
