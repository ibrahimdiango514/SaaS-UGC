# ÉTAPE 3 — Diagnostic des intégrations : boutique Chariow

Statut : **connecteur vérifié conforme à l'API réelle ; cause probable de
l'échec identifiée (dérive d'épinglage Edge) ; test authentifié impossible sans
clé.**

## 1. Ce qui a été vérifié concrètement

### 1.1 Conformité à la documentation officielle Chariow

Comparaison du client `src/business/importer/chariow-api.ts` avec la référence
publiée (`chariow.dev/api-reference`, `openapi.json`) :

| Élément | Documentation Chariow | Code du dépôt | Verdict |
| --- | --- | --- | --- |
| Base | `https://api.chariow.com/v1` | `CHARIOW_API_BASE` identique | conforme |
| Authentification | `Authorization: Bearer sk_live_…` | en-tête `authorization: Bearer ${apiKey}` | conforme |
| Boutique | `GET /v1/store` → `{ data: Store }` | `probeChariow` lit `/store` puis `/products` | conforme |
| Produits | `GET /v1/products`, `per_page` max 100, `cursor` | pagination par `pagination.next_cursor` | conforme |
| Fin de pagination | `pagination.has_more_pages` | `has_more_pages === true || next_cursor !== null` | conforme, avec repli sûr |
| Statuts produit | `published` / `draft` / `suspended` (la liste renvoie **tous** les statuts) | filtre `published`, comptage des brouillons | conforme |
| Prix | `pricing.effective` / `current_price` / `price` en `{ value, currency }` | `pickChariowPrice` avec ordre de repli | conforme |
| Stock | `quantity` nullable (null = illimité) | `stock: number \| null`, jamais 0 par défaut | conforme |
| Scopes | `store.read`, `products.read`, 403 + `errors.scopes` | seuls ces deux scopes ; scopes manquants remontés | conforme |

Les 64 tests du connecteur passent :
`tests/chariow-catalog.test.ts` (44) + `tests/chariow-connect.test.ts` (20).

### 1.2 Cause probable de l'échec constaté

**Dérive d'épinglage des artefacts Edge.** `store-connect` n'est pas déployé
depuis sa source : `supabase/functions/store-connect/loader.ts` télécharge un
bundle figé depuis GitHub, puis vérifie **taille + SHA-256** avant exécution. Le
renommage SORAHNEX/SORAHNEX → SORAHNEX a modifié des chaînes affichées **à
l'intérieur des bundles** (`store-connect`, `store-import`, `mcp-client`,
`business-grow`). Résultat mesuré :

| Chargeur | Taille épinglée | Taille actuelle | Empreinte épinglée | Empreinte actuelle |
| --- | --- | --- | --- | --- |
| `store-connect` | 81 356 | 81 320 | `d765772d…` | `5448e1d7…` (bundle courant) |
| `store-import` | 113 906 | 113 906 | `e23ed55a…` | `f328afbe…` |
| `mcp-client` | 72 787 | 72 823 | `909111c3…` | `76208f73…` |
| `business-grow` | 88 235 | 88 139 | `ca9f76e5…` | `da83f923…` |

Tant que le chargeur n'est pas réépinglé, la fonction déployée exécute l'ANCIEN
bundle (celui du commit épinglé) ou, si le bundle est poussé sans réépinglage,
répond **503 `STORE_CONNECT_ARTIFACT_UNAVAILABLE`** : la connexion de boutique
échoue alors sans message utile côté marchand.

Les quatre chargeurs à tranches (`vyora-ai`, `vyora-ai-providers`,
`vyora-provider-health`, `vyora-mcp`) avaient la même dérive et ont été
**régénérés** (`node scripts/build-edge-loader.mjs --all`) : migrations de
tranches, `loader.ts` et `*.edge.js` réalignés.

**Procédure de réépinglage** (à exécuter après le commit qui contient les
nouveaux bundles, puis à committer séparément) :

```bash
EDGE_PIN_COMMIT=<sha40 du commit contenant les bundles> \
  node scripts/build-edge-artifact.mjs store-import
EDGE_PIN_COMMIT=<sha40> node scripts/build-edge-artifact.mjs store-connect
EDGE_PIN_COMMIT=<sha40> node scripts/build-edge-artifact.mjs mcp-client
BG_PIN_COMMIT=<sha40>  node scripts/build-business-grow-artifact.mjs
```

Le test `tests/store-import-artifact.test.ts` échoue si un chargeur ne
correspond plus à son bundle : la dérive ne peut plus passer inaperçue.

### 1.3 Autres causes possibles, non écartées

1. **Clé absente ou sans scope** : sans clé `sk_live_…` avec `store.read` +
   `products.read`, le parcours s'arrête à la sonde (401/403) — c'est un état
   « configuration requise », pas une panne.
2. **Abonnement Grow inactif** : `recordConnection` renvoie
   `SUBSCRIPTION_REQUIRED` (403).
3. **Désaccord d'appartenance** : si l'URL de vitrine saisie et `store.url`
   renvoyée par Chariow diffèrent (domaine personnalisé vs
   `*.mychariow.online`), le handler renvoie `SHOP_MISMATCH` (409). La
   comparaison est stricte sur le **nom d'hôte** (`sameShopOrigin`), ce qui est
   volontaire ; un sous-domaine différent est bien un désaccord.

Aucun test authentifié n'a été exécuté : aucune clé Chariow n'est disponible
dans cet environnement.

## 2. États d'interface exigés

Le parcours doit distinguer, sans jamais afficher « connecté » sans preuve
serveur : **connectée**, **non connectée**, **configuration requise**,
**expirée**, **erreur**, **synchronisation**. L'état affiché doit venir du
`status` enregistré par `store-connect` et des `resourcesRead` réellement lus
(`store`, `products`), jamais d'un booléen local.

## 3. Reste à faire

- Réépingler les quatre chargeurs GitHub (procédure §1.2) puis redéployer
  `store-connect` — **nécessite un commit poussé et un accès de déploiement**.
- Test authentifié avec la clé du marchand (`ewbnibvk.mychariow.online`).
- Revue des autres plateformes : Shopify/Woo restent en **lecture publique
  seule** (pas de parcours de connexion), les autres fournisseurs déclarés ne
  sont pas fonctionnels — à présenter comme « configuration externe requise ».
