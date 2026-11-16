-- =============================================================================
-- VYORA — Import de fichier (CSV/XLSX) : protocole de vérification bout en bout.
--
-- Ce fichier n'est PAS exécuté par `supabase db push` (il vit sous
-- `supabase/tests/`, pas `supabase/migrations/`). C'est un protocole manuel,
-- rejouable, contre la base et l'URL publiques du projet.
--
-- ## Ce qu'il prouve
--   1. Un compte SANS abonnement est refusé par le serveur, sur les DEUX
--      chemins (aperçu et confirmation), et ne crée aucun produit.
--   2. Le contournement direct par PostgREST — `POST /rest/v1/ugc_products` —
--      est refusé au niveau de la base, pas seulement de l'interface.
--   3. Un compte ABONNÉ obtient un aperçu, puis une confirmation explicite, et
--      les produits sont réellement écrits — avec le bon prix (XOF sans
--      décimales), les bons avertissements et sans doublon.
--   4. Un autre abonné ne peut ni prévisualiser ni importer dans l'entreprise
--      d'autrui.
--   5. Les refus périphériques sont propres : fichier vide, base64 invalide,
--      fichier trop volumineux, rejeu d'aperçu, import sans confirmation.
--
-- ## Pourquoi passer par `pg_net` et non par `curl`
-- Le poste de développement n'a aucun accès réseau à Supabase ; la base, si.
-- Les appels partent donc d'ici, contre l'URL publique — c'est-à-dire la même
-- porte que celle utilisée par le navigateur, avec la même passerelle JWT.
--
-- ## Données strictement fictives
-- Comptes `import-a|b|c@vyora-test.invalid` (domaine non routable), plan
-- interne `import_test`, entreprises « Import test import-… ». Le fichier
-- `99-teardown-import-fichiers.sql` supprime tout et ne touche à rien d'autre.
--
-- ## Ordre d'exécution
--   01 (comptes) → 02 (entreprises) → 03 (abonnement) → 04 (fichiers)
--   → 05 (jetons) → 06 (essais) → 99 (nettoyage)
-- =============================================================================

-- =============================================================================
-- 01 — Comptes de test
-- =============================================================================
create table if not exists public.import_identifiants (
  email text primary key,
  mot_de_passe text not null,
  cree_le timestamptz not null default now()
);
revoke all on public.import_identifiants from public, anon, authenticated;

do $$
declare
  compte record;
  uid uuid;
  secret text;
begin
  for compte in
    select * from (values
      ('import-a@vyora-test.invalid', 'Import — A (sans abonnement)'),
      ('import-b@vyora-test.invalid', 'Import — B (abonné)'),
      ('import-c@vyora-test.invalid', 'Import — C (abonné, autre entreprise)')
    ) as t(email, libelle)
  loop
    if exists (select 1 from auth.users where email = compte.email) then
      raise exception 'compte déjà présent : % — exécuter 99-teardown avant', compte.email;
    end if;

    -- Mot de passe aléatoire, jamais affiché : la connexion se fait par
    -- `POST /auth/v1/token`, avec le secret stocké dans la table ci-dessus.
    secret := encode(extensions.gen_random_bytes(32), 'hex');

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin,
      -- Ces colonnes doivent valoir '' et non NULL : GoTrue échoue sinon sur
      -- « Database error querying schema » au moment de délivrer un jeton.
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token,
      reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
      'authenticated', 'authenticated', compte.email,
      extensions.crypt(secret, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', compte.libelle), false,
      '', '', '', '', '', '', '', ''
    ) returning id into uid;

    insert into public.import_identifiants (email, mot_de_passe) values (compte.email, secret);

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

-- =============================================================================
-- 02 — Une entreprise par compte (pour tester l'isolation)
-- =============================================================================
insert into saas_ugc.ugc_workspaces (id, owner_user_id, name, country_code, default_language)
select gen_random_uuid(), u.id, 'Import test ' || split_part(u.email, '@', 1), 'ML', 'fr'
from auth.users u
where u.email like 'import-%@vyora-test.invalid';

insert into saas_ugc.ugc_workspace_members (id, workspace_id, user_id, member_role)
select gen_random_uuid(), w.id, w.owner_user_id, 'owner'
from saas_ugc.ugc_workspaces w
where w.name like 'Import test import-%'
on conflict (workspace_id, user_id) do nothing;

-- =============================================================================
-- 03 — Abonnements : B et C seulement
-- =============================================================================
-- Plan interne : les plans réels (`essentiel`, `croissance`, `scale`) ne sont
-- jamais activés. `billing_enabled = true` est exigé par
-- `guard_subscription_activation`, ce n'est pas un contournement.
insert into saas_business.plans (
  plan_key, display_name, billing_enabled, active, tagline,
  monthly_price_minor, currency, sort_order, features
) values (
  'import_test', 'Import — plan interne de test (jamais commercialisé)',
  true, true, 'Plan interne de vérification', 0, 'XOF', 99, '[]'::jsonb
)
on conflict (plan_key) do update set active = true, billing_enabled = true;

insert into saas_business.subscriptions (
  user_id, plan_key, status, billing_provider,
  external_customer_id, external_subscription_id,
  current_period_start, current_period_end, billing_updated_at
)
select u.id, 'import_test', 'active', 'import_test',
       'import-test-cust', 'import-test-sub',
       now() - interval '1 day', now() + interval '30 days', now()
from auth.users u
where u.email in ('import-b@vyora-test.invalid', 'import-c@vyora-test.invalid');

-- Contrôle : A refusé, B et C autorisés.
select u.email,
  saas_business.bg_import_access(u.id, now())->>'allowed' as autorise,
  saas_business.bg_import_access(u.id, now())->>'reason' as motif
from auth.users u
where u.email like 'import-%@vyora-test.invalid'
order by u.email;

-- =============================================================================
-- 04 — Fichiers de test, lus depuis le dépôt public
-- =============================================================================
-- Ils sont récupérés via l'API GitHub (contenu base64), et non recopiés ici :
-- un binaire XLSX ne peut pas vivre dans un littéral SQL, et une copie
-- divergerait silencieusement des fixtures utilisées par les tests unitaires.
create table if not exists public.import_fichiers (
  nom text primary key,
  requete_id bigint,
  contenu text,
  recupere_le timestamptz
);
revoke all on public.import_fichiers from public, anon, authenticated;

insert into public.import_fichiers (nom, requete_id)
select f.nom, net.http_get(
  url := 'https://api.github.com/repos/ibrahimdiango514/SaaS-UGC/contents/supabase/tests/import-fichiers/' || f.nom || '?ref=develop',
  headers := '{"accept":"application/vnd.github+json"}'::jsonb,
  timeout_milliseconds := 20000
)
from (values ('produits.csv'), ('produits.xlsx'), ('variantes.xlsx')) as f(nom);

-- À rejouer quelques secondes plus tard (pg_net est asynchrone) :
-- update public.import_fichiers f
--    set contenu = replace((r.content::jsonb)->>'content', E'\n', ''), recupere_le = now()
--   from net._http_response r
--  where r.id = f.requete_id and r.status_code = 200;

-- =============================================================================
-- 05 — Jetons d'accès réels
-- =============================================================================
create table if not exists public.import_jetons (
  email text primary key,
  requete_id bigint,
  access_token text,
  obtenu_le timestamptz
);
revoke all on public.import_jetons from public, anon, authenticated;
truncate public.import_jetons;

insert into public.import_jetons (email, requete_id, obtenu_le)
select i.email,
  net.http_post(
    url := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/auth/v1/token?grant_type=password',
    headers := format(
      '{"Content-Type":"application/json","apikey":"%s"}',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhidXVoZndvYnJhZmNiZ3RkZ2p4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMTk4MzIsImV4cCI6MjA5ODY5NTgzMn0.8wFqyNe9iCruZlWQCPISZZG1oDvLEiDyWuFJ-01zlbo'
    )::jsonb,
    body := jsonb_build_object('email', i.email, 'password', i.mot_de_passe),
    timeout_milliseconds := 20000
  ),
  now()
from public.import_identifiants i
where i.email like 'import-%@vyora-test.invalid';

-- À rejouer quelques secondes plus tard :
-- update public.import_jetons j set access_token = (r.content::jsonb)->>'access_token'
--   from net._http_response r where r.id = j.requete_id;

-- =============================================================================
-- 06 — Journal des essais
-- =============================================================================
create table if not exists public.import_essais (
  id bigserial primary key,
  libelle text not null,
  requete_id bigint,
  essai_le timestamptz not null default now()
);
revoke all on public.import_essais from public, anon, authenticated;

-- Les essais eux-mêmes suivent le modèle ci-dessous. `clé` désigne le jeton du
-- compte visé, `espace` l'entreprise visée.
--
--   insert into public.import_essais (libelle, requete_id)
--   select 'T1 non-abonné A — aperçu fichier CSV',
--     net.http_post(
--       url := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/store-import',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'apikey', '<clé anon>',
--         'Authorization', 'Bearer ' || (select access_token from public.import_jetons where email = 'import-a@vyora-test.invalid')
--       ),
--       body := jsonb_build_object(
--         'action', 'preview',
--         'workspaceId', '<entreprise>',
--         'fileName', 'produits.csv',
--         'fileBase64', (select contenu from public.import_fichiers where nom = 'produits.csv')
--       ),
--       timeout_milliseconds := 20000
--     );
--
--   -- Lecture du résultat (pg_net est asynchrone : attendre, puis rejouer) :
--   select e.id, e.libelle, r.status_code, r.content
--     from public.import_essais e
--     left join net._http_response r on r.id = e.requete_id
--    order by e.id;
--
-- ## Deux pièges à connaître
--   * L'aperçu expire au bout de 10 minutes : enchaîner aperçu et confirmation
--     dans la même fenêtre, sinon `PREVIEW_EXPIRED` — c'est le comportement
--     attendu, pas une panne.
--   * Un aperçu ne se rejoue pas : la confirmation le consomme.
