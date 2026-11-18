-- =============================================================================
-- P6d — Protocole de validation OAuth sortante, EN RÉEL, depuis la base.
--
-- Pourquoi depuis la base : l'environnement de développement n'a pas d'accès
-- réseau aux domaines de production ; `pg_net` (dans le projet Supabase), lui,
-- joint la fonction `mcp-client` et les vrais fournisseurs. Les réponses sont
-- relues dans `net._http_response` (asynchrone : attendre quelques secondes).
--
-- Tout ce qui est créé ici porte un marqueur (`p6d-…@vyora-test.invalid`,
-- « P6d test », « (test P6d) ») et est détruit par la section 99.
-- Aucun secret n'apparaît : les mots de passe sont générés en base, les JWT
-- n'en sortent jamais, la clé `sb_publishable_…` est publique par conception.
-- =============================================================================

-- 01 — Deux comptes : A (propriétaire), B (pour l'isolation). Un déclencheur
--      crée déjà l'adhésion « owner » à l'espace : ne pas l'insérer soi-même.
create table if not exists public._p6d_identifiants(
  email text primary key, mot_de_passe text not null,
  user_id uuid, workspace_id uuid, jwt text, requete_id bigint
);
revoke all on public._p6d_identifiants from public, anon, authenticated;

do $$
declare compte record; uid uuid; wid uuid; secret text;
begin
  for compte in
    select * from (values
      ('p6d-a@vyora-test.invalid', 'P6d — A (OAuth)'),
      ('p6d-b@vyora-test.invalid', 'P6d — B (isolation)')
    ) as t(email, libelle)
  loop
    if exists (select 1 from auth.users where email = compte.email) then
      raise exception 'compte déjà présent : % — exécuter la section 99 avant', compte.email;
    end if;
    secret := encode(extensions.gen_random_bytes(32), 'hex');
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', compte.email,
      extensions.crypt(secret, extensions.gen_salt('bf')), now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', compte.libelle), false,
      '', '', '', '', '', '', '', ''
    ) returning id into uid;
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, 'email',
            jsonb_build_object('sub', uid::text, 'email', compte.email, 'email_verified', true), now(), now(), now());
    insert into saas_ugc.ugc_workspaces (id, owner_user_id, name, country_code, default_language)
    values (gen_random_uuid(), uid, 'P6d test ' || split_part(compte.email, '@', 1), 'ML', 'fr') returning id into wid;
    insert into public._p6d_identifiants(email, mot_de_passe, user_id, workspace_id) values (compte.email, secret, uid, wid);
  end loop;
end $$;

-- 02 — Jetons GoTrue réels (mot de passe → access_token), puis relecture.
update public._p6d_identifiants i set requete_id = net.http_post(
  url := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/auth/v1/token?grant_type=password',
  headers := '{"Content-Type":"application/json","apikey":"sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz"}'::jsonb,
  body := jsonb_build_object('email', i.email, 'password', i.mot_de_passe),
  timeout_milliseconds := 20000);
-- Quelques secondes plus tard :
-- update public._p6d_identifiants i set jwt = (r.content::jsonb)->>'access_token'
--   from net._http_response r where r.id = i.requete_id and r.status_code = 200;

-- 03 — Journal + appel d'une route de gestion au nom d'un compte (ou anonyme).
create table if not exists public._p6d_essais(id bigserial primary key, libelle text not null, requete_id bigint, cree_le timestamptz default now());
revoke all on public._p6d_essais from public, anon, authenticated;

create or replace function public._p6d_appel(p_libelle text, p_compte text, p_route text, p_corps jsonb)
returns bigint language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_jwt text; v_id bigint;
begin
  if p_compte is not null then select jwt into v_jwt from public._p6d_identifiants where email = p_compte; end if;
  v_id := net.http_post(
    url := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/gestion/' || p_route,
    headers := case when v_jwt is null then '{"content-type":"application/json"}'::jsonb
               else jsonb_build_object('content-type','application/json','authorization','Bearer ' || v_jwt) end,
    body := p_corps, timeout_milliseconds := 30000);
  insert into public._p6d_essais(libelle, requete_id) values (p_libelle, v_id);
  return v_id;
end $$;
revoke all on function public._p6d_appel(text,text,text,jsonb) from public, anon, authenticated;

-- 04 — Campagne (chaque appel est relu ensuite dans net._http_response).
--   creer (oauth, SANS secret) → 201, status auth_required
--   oauth-demarrer (A)         → 200 : DCR réel chez le fournisseur, redirect_uri https public
--   oauth-demarrer (B sur A)   → 404
--   GET /oauth/callback?state=<réel>&code=forgé → 502 (le fournisseur refuse : invalid_grant)
--   GET /oauth/callback?state=<même>            → 400 (usage unique)
--   état expiré (expire_le dans le passé)        → 400
--   lister/tester/executer/oauth-revoquer (B sur A) → [] / 404 / 404 / 404 ; anonyme → 401
--   oauth-revoquer (A)         → 200 distant=revoque, 0 secret, 0 flux, auth_required
--   executer après révocation  → 409 ; tester → 409 auth_required ; re-demarrer → 200 (client réutilisé)
--   executer avec accès expiré + refresh factice → 409 auth_required (invalid_grant du vrai point de jeton)
--   oauth-demarrer avec redirect_uri hostile dans le corps → ignoré

-- 99 — Nettoyage (ne touche QUE les marqueurs ci-dessus).
-- do $$
-- declare r record;
-- begin
--   for r in select id from public.mcp_servers where user_id in (select user_id from public._p6d_identifiants) loop
--     perform public.mcp_oauth_detruire(r.id);
--   end loop;
--   delete from public.mcp_servers_secrets where user_id in (select user_id from public._p6d_identifiants);
--   delete from public.mcp_servers where user_id in (select user_id from public._p6d_identifiants);
--   delete from saas_ugc.ugc_workspace_members where workspace_id in (select workspace_id from public._p6d_identifiants);
--   delete from saas_ugc.ugc_workspaces where id in (select workspace_id from public._p6d_identifiants);
--   delete from auth.identities where user_id in (select user_id from public._p6d_identifiants);
--   delete from auth.users where id in (select user_id from public._p6d_identifiants);
-- end $$;
-- drop function if exists public._p6d_appel(text,text,text,jsonb);
-- drop table if exists public._p6d_identifiants; drop table if exists public._p6d_essais;
