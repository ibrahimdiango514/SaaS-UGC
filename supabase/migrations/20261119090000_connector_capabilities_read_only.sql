-- Les capacités déclarées doivent correspondre au code qui existe.
--
-- ## Le défaut corrigé
-- `prestashop` déclarait `{read, write, modify}` et `chariow` était correct
-- (`{read}`). Or aucune des deux Edge Functions n'implémente d'écriture :
--
--   * `safe-egress.ts` refuse explicitement toute méthode autre que `GET` ;
--   * `buildRequest()` de `pinned-fetch.ts` écrit `GET` en dur.
--
-- Déclarer `write`/`modify` n'est donc pas une imprécision : c'est une
-- promesse fausse, que l'interface peut afficher à un utilisateur qui
-- l'attendra à l'usage. Cette migration aligne la base sur le code, puis
-- empêche l'écart de se reproduire.
--
-- ## Pourquoi une contrainte plutôt qu'un simple update
-- Corriger les valeurs ne protège que d'aujourd'hui. La contrainte, elle,
-- refuse la réintroduction d'une capacité d'écriture tant qu'aucun code
-- d'écriture n'est livré. Le jour où il l'est, il faudra retirer la contrainte
-- volontairement — c'est-à-dire y avoir pensé.
--
-- ## Ce que cette migration ne fait pas
-- Elle ne supprime aucune ligne, ne retire aucun fournisseur, et ne touche pas
-- à `bg_validate_connector_key`, qui dépend de la présence des lignes, pas de
-- leurs capacités.

-- ---------------------------------------------------------------------------
-- 1. Aligner les valeurs sur le code réellement déployé.
-- ---------------------------------------------------------------------------
update saas_business.integration_providers
   set capabilities = array['read']::text[]
 where provider_key in ('prestashop', 'chariow')
   and capabilities is distinct from array['read']::text[];

-- ---------------------------------------------------------------------------
-- 2. Interdire toute capacité d'écriture sur un connecteur déclaré implémenté.
--
-- La contrainte ne vise que `implemented = true` : un fournisseur en
-- préparation peut légitimement annoncer une capacité future, à condition de
-- ne pas se présenter comme disponible.
-- ---------------------------------------------------------------------------
alter table saas_business.integration_providers
  drop constraint if exists integration_providers_read_only_capabilities;

alter table saas_business.integration_providers
  add constraint integration_providers_read_only_capabilities
  check (
    not implemented
    or capabilities is null
    or not (capabilities && array['write', 'modify', 'delete']::text[])
  );

comment on constraint integration_providers_read_only_capabilities
  on saas_business.integration_providers is
  'Un connecteur déclaré implémenté ne peut annoncer une écriture : la sortie réseau de store-connect et store-import n''émet que des GET.';

-- ---------------------------------------------------------------------------
-- 3. Contrôles : échouer plutôt que laisser passer une incohérence.
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_caps text[];
  v_impl boolean;
begin
  select capabilities, implemented
    into v_caps, v_impl
    from saas_business.integration_providers
   where provider_key = 'prestashop';

  if v_caps is null then
    raise exception 'prestashop absent de integration_providers';
  end if;
  if v_caps <> array['read']::text[] then
    raise exception 'prestashop : capacités attendues {read}, trouvées %', v_caps;
  end if;
  if v_impl is not true then
    raise exception 'prestashop : implemented devrait rester true';
  end if;

  -- La validation de clé doit continuer d'accepter les deux connecteurs : si
  -- un update maladroit les avait retirés, c'est ici qu'on le verrait.
  if saas_business.bg_validate_connector_key('prestashop') <> 'prestashop' then
    raise exception 'bg_validate_connector_key refuse prestashop';
  end if;
  if saas_business.bg_validate_connector_key('chariow') <> 'chariow' then
    raise exception 'bg_validate_connector_key refuse chariow';
  end if;
end $verif$;
