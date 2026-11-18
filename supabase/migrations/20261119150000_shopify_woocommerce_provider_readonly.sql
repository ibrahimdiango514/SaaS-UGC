-- VYORA — Shopify et WooCommerce : le registre cesse de promettre OAuth et
-- l'écriture.
--
-- ## Ce qui était faux
--
-- `integration_providers` déclarait, avant cette migration :
--
--   shopify      → auth_mode `oauth2`, capabilities [read, draft, send,
--                  modify, write], implemented = false
--   woocommerce  → auth_mode `api-key`, capabilities [read, write, modify],
--                  implemented = false
--
-- Les deux lignes mentaient, et sur trois points à la fois :
--
--   1. **Mode d'authentification.** Le connecteur lit Shopify avec un JETON
--      D'APPLICATION PERSONNALISÉE (`shpat_…`, en-tête
--      `X-Shopify-Access-Token`). Aucun parcours OAuth n'existe côté serveur :
--      sans `SHOPIFY_API_SECRET` en variables d'environnement, une redirection
--      OAuth échouerait dès la première étape. Annoncer `oauth2` promettait un
--      bouton qui n'a jamais existé.
--
--   2. **Capacités.** `write`, `modify`, `draft`, `send` supposent des écritures
--      chez le marchand. Or le client n'émet que des `GET` — `safe-egress.ts`
--      refuse toute autre méthode — et les capacités d'écriture n'existent même
--      pas dans le type `ConnectorRequirement`. Une ligne qui annonce
--      `modify` pour un connecteur incapable d'écrire est exactement ce que
--      l'audit de la phase A devait éliminer.
--
--   3. **`implemented`.** Il valait `false` alors que le connecteur est
--      désormais écrit ET déployé (`store-connect` v9, `store-import` v18).
--
-- ## Ce que cette migration pose
--
-- Les valeurs sont EXACTEMENT celles que le code applique, et rien de plus :
--
--   shopify      → api-key, [read], true
--   woocommerce  → api-key, [read], true
--
-- `chariow` (`api-key`, [read], true) et `prestashop` (idem) sont laissés tels
-- quels : ils étaient déjà justes. `opencart` n'est pas touché — il conserve
-- `implemented = false` et ses capacités d'origine, car aucune route
-- `api/products` n'existe dans le cœur d'OpenCart et ce chantier ne fabrique
-- aucun endpoint.
--
-- ## Rejouable
--
-- `do update` est volontaire : si un connecteur change un jour de mode
-- d'authentification, la ligne doit pouvoir être corrigée sans laisser une
-- déclaration périmée derrière elle.

insert into saas_business.integration_providers (provider_key, auth_mode, capabilities, implemented)
values
  ('shopify',     'api-key', array['read'], true),
  ('woocommerce', 'api-key', array['read'], true)
on conflict (provider_key) do update
  set auth_mode    = excluded.auth_mode,
      capabilities = excluded.capabilities,
      implemented  = excluded.implemented;

comment on column saas_business.integration_providers.implemented is
  'Connecteur réellement écrit et déployé, en LECTURE SEULE. true pour chariow, prestashop, shopify et woocommerce : la connexion est vérifiée par une lecture réelle de l''API.';

-- ---------------------------------------------------------------------------
-- Contrôles : la migration échoue plutôt que de laisser un état incohérent.
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_shopify     saas_business.integration_providers%rowtype;
  v_woocommerce saas_business.integration_providers%rowtype;
begin
  select * into v_shopify
    from saas_business.integration_providers where provider_key = 'shopify';
  if not found then
    raise exception 'shopify absent de integration_providers';
  end if;

  select * into v_woocommerce
    from saas_business.integration_providers where provider_key = 'woocommerce';
  if not found then
    raise exception 'woocommerce absent de integration_providers';
  end if;

  -- Aucune capacité d'écriture ne doit subsister : c'est le cœur de la
  -- correction, et le point qui pourrait le plus facilement régresser.
  if v_shopify.capabilities <> array['read']::text[] then
    raise exception 'shopify : capacités inattendues %', v_shopify.capabilities;
  end if;
  if v_woocommerce.capabilities <> array['read']::text[] then
    raise exception 'woocommerce : capacités inattendues %', v_woocommerce.capabilities;
  end if;

  if v_shopify.auth_mode <> 'api-key' then
    raise exception 'shopify : auth_mode % au lieu de api-key', v_shopify.auth_mode;
  end if;
  if v_woocommerce.auth_mode <> 'api-key' then
    raise exception 'woocommerce : auth_mode % au lieu de api-key', v_woocommerce.auth_mode;
  end if;

  if not v_shopify.implemented or not v_woocommerce.implemented then
    raise exception 'shopify et woocommerce doivent être implemented';
  end if;
end
$verif$;
