# PrestaShop — connecteur de bout en bout (Phase C)

État au commit `98137ee` de la branche `arena/0188834f-saas-ugc`.

Ce rapport ne décrit que ce qui a été **exécuté**. Les points non exécutables
dans cet environnement sont nommés comme tels, plus bas.

## 1. Ce qui fonctionne réellement

### Connexion

`POST /functions/v1/store-connect` avec `{ action: 'connect', workspaceId, url, apiKey }`.

1. Authentification par GoTrue (`/auth/v1/user`) — jamais un en-tête déclaratif.
2. Abonnement Business Grow **actif et payé** via `bg_import_access`, contrôlé
   avant toute sortie réseau, y compris pour `status`.
3. Droit d'écriture sur l'entreprise via `bg_can_workspace` (identifiant
   d'entreprise fourni par le client : contrôlé, jamais cru).
4. Résolution DNS + refus des adresses privées/internes + connexion TCP épinglée
   sur l'IP validée, avec revalidation à chaque redirection.
5. Lecture réelle de `shops` et `languages` (une page de connexion en 200 ne
   compte pas comme une connexion réussie).
6. Clé déposée dans **Vault** ; `credential_ref` ne garde que le **nom** du
   secret. La réponse ne contient ni clé, ni nom de secret.

### Import

`store-import`, `action: 'preview'` avec `url` d'une boutique PrestaShop :

- lit la clé depuis Vault (**côté serveur uniquement**) ;
- lit `products`, `combinations`, `product_option_values`, `product_options`,
  `stock_availables` par l'API Webservice, avec pagination réelle
  (`limit=offset,n`, total via `Content-Range`), plafonds (5 000 produits,
  400 déclinaisons) et reprise sur 429/5xx ;
- **une déclinaison reste une variante**, jamais un produit ;
- prix : `priceMinor` est la valeur de référence (corrige la double conversion
  24,90 → 25) ; devise de la boutique ; stock réel depuis `stock_availables`,
  avec repli signalé sur le cache `combinations.quantity` ;
- SKU produit et SKU de déclinaison conservés, identifiant stable
  (`platformId` = id PrestaShop) ;
- passe par le **même** normaliseur, le **même** rapprochement (`matchBatch`),
  le **même** aperçu et la **même** confirmation que Shopify/WooCommerce ;
- erreurs explicites : `CONNECTION_REQUIRED` 409, `STORE_CONNECTION_REFUSED`
  401 (clé refusée ou droits insuffisants), `CATALOG_UNAVAILABLE` 502,
  `CATALOG_EMPTY` 422, `CONNECTOR_UNAVAILABLE` 503.

### Déconnexion

- `bg_disconnect_integration` remet la ligne à `disconnected` **et** vide
  `credential_ref`, puis le secret est retiré de Vault. Avant cette correction,
  la suppression du secret laissait le statut `connected` : l'écran annonçait
  une connexion morte.

## 2. Défauts réels trouvés et corrigés dans cette phase

| Défaut | Conséquence | Correction |
|---|---|---|
| `probePrestashop` importé du mauvais module | 500 `STORE_CONNECT_BACKEND_ERROR` sur **toutes** les actions | import depuis `prestashop-catalog.ts` |
| `Authorization` non transmis par la sortie épinglée | 401 sur toute API authentifiée | en-tête transmis, **au seul hôte demandé**, jamais suivi sur une redirection |
| Statut HTTP écrasé en « injoignable » | une clé révoquée devenait une panne réseau (502) | statut remonté puis classifié (401/403/429/5xx) |
| `store-connect` sans origine CORS par défaut | connecteur parfait en `curl`, bloqué dans l'application | liste partagée, non vide, motifs réellement comparés |
| Motifs CORS comparés par `startsWith`/`endsWith` | `…netlify.app.evil.test` accepté comme prévisualisation | joker strict, ancrage début **et** fin |
| PrestaShop `engine: null` + `needs_config` non connectable | le connecteur existait sans être atteignable | `engine: 'api-key'`, `needs_config` connectable, formulaire dans la fiche |
| `orders-read` annoncé | capacité affichée mais non implémentée | retirée de la fiche |
| `store-connect` hors `tsconfig.edge.json` | fonction déployée jamais typée | incluse, avec test qui l'impose |

## 3. Vérifications exécutées

| Vérification | Résultat |
|---|---|
| `npx tsc -b` | 0 erreur |
| `npx tsc -p tsconfig.edge.json` | 0 erreur (store-import **et** store-connect) |
| `npx vitest run` | **2206 tests, 136 fichiers, 0 échec** |
| Parité chargeur ↔ artefact épinglé (2 fonctions) | 20 tests OK (`git show <commit>:artefact`) |
| Signature des RPC en base | conforme aux appels de l'adaptateur |
| `bg_connect_integration` sans abonnement | refusé : `connect_forbidden:SUBSCRIPTION_REQUIRED:NO_SUBSCRIPTION` |
| `bg_disconnect_integration` sur l'entreprise d'autrui | refusé : `workspace access denied` |
| `bg_disconnect_integration` sur un connecteur inconnu | refusé : `invalid connecteur key` (22023) |
| `bg_disconnect_integration` nominal | `{status: not_connected, disconnected: true}` |
| `integration_connection_checks` : RLS + droits | RLS active, SELECT seul, aucun INSERT/UPDATE pour `authenticated` |
| Déploiement Edge | `store-import` v15, `store-connect` v4, ACTIVE, `verify_jwt: true`, épinglés sur `83bf063` |

## 4. Ce qui n'a PAS été exécuté — et pourquoi

- **Aucun appel HTTP réel vers une boutique PrestaShop.** Le sandbox n'a pas de
  route sortante vers `*.supabase.co`, et je ne dispose d'aucune boutique
  PrestaShop de test autorisée. Les parcours sont couverts par des réponses
  d'API réalistes (enveloppe `prestashop`, `Content-Range`, multi-langue,
  incidence de prix, stocks) dans des doublures, pas par une connexion réelle.
- **Aucun appel authentifié aux Edge Functions déployées** (même raison
  réseau). Le déploiement est vérifié par la version, le statut et l'épinglage,
  pas par une réponse HTTP.
- **Aucun crédit Netlify consommé**, aucun déploiement Netlify.

## 5. Reste à faire

- OpenCart, avec la même architecture (`probe` → Vault → lecture API →
  normalisation → rapprochement), en réutilisant `store-connect` et `store-import`
  sans en dupliquer la logique.
- Vérification de bout en bout sur une boutique réelle, dès qu'une boutique de
  test autorisée est disponible.
