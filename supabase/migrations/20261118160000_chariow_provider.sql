-- Chariow devient un fournisseur d'intégration déclaré.
--
-- ## Pourquoi une migration séparée
-- `integration_providers` est la source de vérité de
-- `bg_validate_connector_key` : une clé absente de cette table est refusée
-- (`22023 invalid connector key`). Ajouter Chariow au catalogue sans le
-- déclarer ici donnerait une fiche cliquable qui échoue au moment d'enregistrer
-- la connexion — exactement le bouton mort qu'on veut éviter.
--
-- ## Capacités
-- `read` UNIQUEMENT. C'est une décision de conception, pas un oubli :
--   - le connecteur n'appelle que `GET /v1/store` et `GET /v1/products` ;
--   - les scopes demandés au marchand sont `store.read` et `products.read` ;
--   - il n'existe aucun code d'écriture, de commande ou de licence.
-- Déclarer `write`/`modify` promettrait une capacité que rien n'implémente.
--
-- ## Mode d'authentification
-- `api-key` : Chariow n'émet que des clés `sk_live_…` en `Authorization:
-- Bearer`. Pas d'OAuth, pas d'installation d'application.
--
-- ## Rejouable
-- `do update` est volontaire, contrairement au seed initial : si le connecteur
-- est retiré un jour, la ligne doit pouvoir être corrigée sans laisser une
-- déclaration périmée. Les valeurs posées ici sont exactement celles que le
-- code applique, donc les réécrire ne peut pas mentir.

insert into saas_business.integration_providers (provider_key, auth_mode, capabilities, implemented)
values ('chariow', 'api-key', array['read'], true)
on conflict (provider_key) do update
  set auth_mode    = excluded.auth_mode,
      capabilities = excluded.capabilities,
      implemented  = excluded.implemented;

comment on column saas_business.integration_providers.implemented is
  'Connecteur réellement écrit et déployé. true pour chariow et prestashop : la connexion est vérifiée par une lecture réelle de l''API.';

-- ---------------------------------------------------------------------------
-- Contrôles : la migration échoue plutôt que de laisser un état incohérent.
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_mode text;
  v_caps text[];
  v_impl boolean;
  v_valide text;
begin
  select auth_mode, capabilities, implemented
    into v_mode, v_caps, v_impl
    from saas_business.integration_providers
   where provider_key = 'chariow';

  if v_mode is null then
    raise exception 'chariow absent de integration_providers';
  end if;
  if v_mode <> 'api-key' then
    raise exception 'chariow : auth_mode attendu api-key, trouvé %', v_mode;
  end if;
  if v_impl is not true then
    raise exception 'chariow : implemented devrait être true';
  end if;
  -- Lecture seule : aucune capacité d'écriture ne doit être déclarée.
  if v_caps && array['write','modify']::text[] then
    raise exception 'chariow : capacités d''écriture interdites (%),', array_to_string(v_caps, ',');
  end if;
  if not (v_caps @> array['read']::text[]) then
    raise exception 'chariow : la capacité read est requise';
  end if;

  -- La validation de clé de connecteur doit désormais accepter chariow.
  v_valide := saas_business.bg_validate_connector_key('chariow');
  if v_valide <> 'chariow' then
    raise exception 'bg_validate_connector_key refuse chariow';
  end if;
end $verif$;
