-- VYORA — Integration Engine : ouverture du socle OAuth aux connecteurs réels.
--
-- ## Pourquoi cette migration
--
-- `public.oauth_accounts` porte une contrainte `CHECK` limitant `provider` à
-- trois valeurs : 'gmail', 'google_drive', 'google_calendar'. C'est exact pour
-- le socle Google d'origine, mais bloquant pour tout connecteur supplémentaire :
-- un compte Shopify ne peut pas être enregistré, quel que soit le code écrit.
--
-- ## Ce que cette migration change
--
-- La liste fermée est remplacée par une validation par table de référence
-- (`saas_business.integration_providers`). Bénéfices :
--   - la liste des fournisseurs devient une donnée, pas une contrainte figée :
--     ajouter un connecteur ne demande plus de reconstruire la contrainte ;
--   - la table porte aussi les métadonnées utiles au moteur (mode, capacités) ;
--   - la validation reste stricte : une clé non déclarée est refusée.
--
-- ## Ce qui n'est PAS touché
--
--   - aucune ligne n'est lue, modifiée ni supprimée ;
--   - `capabilities`, `status`, `granted_scopes` gardent leurs contraintes ;
--   - les fonctions existantes (`oauth_account_upsert`, `oauth_list_accounts`,
--     `oauth_state_*`, `oauth_audit_*`, `oauth_revoke_account`) restent
--     inchangées ;
--   - les privilèges restent `service_role` uniquement pour les fonctions
--     sensibles (vérifié en base : anon et authenticated n'ont aucun droit).
--
-- ## Réversibilité
--
-- Retour arrière : supprimer la contrainte `oauth_accounts_provider_fk` et
-- recréer l'ancienne contrainte CHECK. Les données restent lisibles dans les
-- deux sens, car les trois valeurs Google d'origine figurent dans la table de
-- référence.

begin;

-- 1) Table de référence des fournisseurs connus du moteur.
create table if not exists saas_business.integration_providers (
  provider_key       text primary key,
  auth_mode          text not null,
  -- capacités que le moteur sait exercer ; sous-ensemble de
  -- ('read','draft','send','modify','write'), aligné sur src/integrations/engine/contract.ts
  capabilities       text[] not null default '{}',
  -- connecteur réellement écrit ? false = aucune connexion possible
  implemented        boolean not null default false,
  created_at         timestamptz not null default now(),
  constraint integration_providers_auth_mode_check
    check (auth_mode in ('oauth2', 'api-key', 'app-install', 'public-catalog', 'file-import')),
  constraint integration_providers_capabilities_check
    check (capabilities <@ array['read', 'draft', 'send', 'modify', 'write']::text[])
);

comment on table saas_business.integration_providers is
  'Fournisseurs connus du moteur d''intégration. Source de vérité pour la validation de oauth_accounts.provider.';

-- 2) Les 26 fournisseurs du catalogue. `implemented = false` partout : aucun
--    connecteur n'est écrit à ce stade, et cette valeur ne doit pas mentir.
insert into saas_business.integration_providers (provider_key, auth_mode, capabilities, implemented) values
  ('instagram',        'oauth2',       array['read','draft','send','modify'], false),
  ('facebook',         'oauth2',       array['read','draft','send','modify'], false),
  ('tiktok',           'oauth2',       array['read','draft','send'],          false),
  ('youtube',          'oauth2',       array['read','draft','send'],          false),
  ('linkedin',         'oauth2',       array['read','draft','send'],          false),
  ('pinterest',        'oauth2',       array['read','draft','send'],          false),
  ('shopify',          'oauth2',       array['read','draft','send','modify','write'], false),
  ('woocommerce',      'api-key',      array['read','write','modify'],        false),
  ('prestashop',       'api-key',      array['read','write','modify'],        false),
  ('magento',          'api-key',      array['read','write','modify'],        false),
  ('opencart',         'api-key',      array['read','write','modify'],        false),
  ('wix',              'oauth2',       array['read','write'],                 false),
  ('bigcommerce',      'api-key',      array['read','write','modify'],        false),
  ('squarespace',      'api-key',      array['read','write'],                 false),
  ('ecwid',            'api-key',      array['read','write'],                 false),
  ('gmail',            'oauth2',       array['read','draft','send','modify'], false),
  ('google_drive',     'oauth2',       array['read','write','modify'],        false),
  ('google_calendar',  'oauth2',       array['read','write','modify'],        false),
  ('microsoft365',     'oauth2',       array['read','draft','send'],          false),
  ('outlook',          'oauth2',       array['read','draft','send'],          false),
  ('slack',            'oauth2',       array['read','send'],                  false),
  ('notion',           'oauth2',       array['read','write'],                 false),
  ('hubspot',          'oauth2',       array['read','write','modify'],        false),
  ('stripe',           'api-key',      array['read'],                         false),
  ('saspay',           'api-key',      array['read','write'],                 false),
  ('odoo',             'api-key',      array['read','write','modify'],        false)
on conflict (provider_key) do nothing;
-- `do nothing` et non `do update` : rejouer cette migration ne doit jamais
-- réécrire `capabilities` ni remettre `implemented` à false après qu'un
-- connecteur réel a été livré.

-- 3) Remplacement de la contrainte fermée par une clé étrangère.
--    La FK est vérifiée sur les lignes existantes : les trois valeurs Google
--    sont présentes ci-dessus, donc une base contenant des comptes réels passe
--    sans modification. Si une valeur inattendue existait, la migration
--    échouerait — c'est voulu : mieux vaut un arrêt qu'une perte silencieuse.
alter table public.oauth_accounts
  drop constraint if exists oauth_accounts_provider_check;

alter table public.oauth_accounts
  drop constraint if exists oauth_accounts_provider_fk;

alter table public.oauth_accounts
  add constraint oauth_accounts_provider_fk
  foreign key (provider)
  references saas_business.integration_providers (provider_key)
  on update cascade
  on delete restrict;

comment on constraint oauth_accounts_provider_fk on public.oauth_accounts is
  'Validation par table de référence : ajouter un fournisseur ne nécessite plus de reconstruire une contrainte CHECK.';

-- 4) RLS sur la table de référence : lecture pour tout utilisateur authentifié,
--    aucune écriture depuis le client. L'ajout d'un fournisseur est une
--    opération d'administration, jamais une action utilisateur.
alter table saas_business.integration_providers enable row level security;

drop policy if exists integration_providers_read on saas_business.integration_providers;
create policy integration_providers_read
  on saas_business.integration_providers
  for select
  to authenticated
  using (true);

revoke insert, update, delete on saas_business.integration_providers from anon, authenticated;
grant select on saas_business.integration_providers to authenticated;

-- 5) Le vérificateur de clé du socle Business Grow accepte désormais tout
--    fournisseur déclaré, sans élargir au-delà : une clé inconnue reste
--    refusée, mais la liste n'est plus codée en dur dans la fonction.
create or replace function saas_business.bg_validate_connector_key(p_connector_key text)
returns text
language plpgsql
stable
set search_path = pg_catalog, saas_business
as $fn$
begin
  if p_connector_key is null
     or not exists (
       select 1 from saas_business.integration_providers p
       where p.provider_key = p_connector_key
     ) then
    raise exception 'invalid connector key' using errcode = '22023';
  end if;
  return p_connector_key;
end $fn$;

comment on function saas_business.bg_validate_connector_key(text) is
  'Valide une clé de connecteur contre saas_business.integration_providers. Refus par défaut : une clé non déclarée lève 22023.';

commit;
