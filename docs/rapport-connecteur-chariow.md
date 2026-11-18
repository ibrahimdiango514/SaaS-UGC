# Rapport — connecteur Chariow livré

**Boutique visée** : `https://ewbnibvk.mychariow.online`
**Branche** : `arena/0188834f-saas-ugc`
**Connecteur Shopify** : non utilisé, à aucun moment.

---

## 0. Ce qui est vrai aujourd'hui, en une phrase

Le connecteur Chariow est **écrit, testé, migré et déployé** ; il ne lui manque
qu'une chose qui ne peut pas venir de moi : **votre clé API**, saisie dans
l'interface. Aucun test authentifié n'a encore eu lieu, et aucun import réel
n'a été lancé.

---

## 1. Fichiers créés ou modifiés

### Créés — le connecteur lui-même

| Fichier | Rôle |
| --- | --- |
| `src/business/importer/chariow-api.ts` | Client de l'API : hôte **fixe**, `Bearer`, pagination **curseur**, classification 401/403/429/5xx, validation de la forme de la clé, lecture des scopes manquants. |
| `src/business/importer/chariow-pricing.ts` | Montants `{ value, currency }` → **unité mineure**, exposant de devise (XOF = 0), choix du prix (`effective` → `current_price` → `price`), stock, images `https` uniquement, comparaison de boutiques. |
| `src/business/importer/chariow-catalog.ts` | Sonde de connexion (`/v1/store` **puis** `/v1/products`), lecture paginée complète, filtre `published`, **comptage des brouillons**, projection vers `RawCatalogProduct`. |
| `src/integrations/ChariowConnectForm.tsx` | Formulaire de connexion : **un seul champ** (la clé), test réel, preuve de lecture, état, vérification à la demande, déconnexion. |
| `supabase/migrations/20261118160000_chariow_provider.sql` | Déclaration du fournisseur : `api-key`, capacités `['read']`, `implemented = true`, avec contrôles bloquants. |
| `tests/chariow-catalog.test.ts` | **44 tests** — pagination, brouillons, prix, devises XOF, images, 401/403, mapping, normalisation commune. |
| `tests/chariow-connect.test.ts` | **20 tests** — parcours `store-connect` et `store-import` réels, secret, abonnement, isolation, appartenance de la clé, confirmation. |

### Modifiés — réutilisation, pas duplication

| Fichier | Modification |
| --- | --- |
| `src/business/importer/platform.ts` | Détection `chariow` (5 indices pondérés) ; `accessFor('chariow')` → `api-authorized`. |
| `src/business/importer/sources.ts` | `CatalogPlatform` += `chariow` ; `RawCatalogProduct.warnings` (avertissements du lecteur). |
| `src/business/importer/pipeline.ts` | Les avertissements du lecteur remontent dans le produit normalisé. Aucune autre logique touchée. |
| `supabase/functions/store-connect/handler.ts` | Registre `{ prestashop: shop-api, chariow: hosted-api }` ; parcours `connecterHerberge` et `previsualiserChariow`. |
| `supabase/functions/store-import/handler.ts` | Branche `chariow` dans l'aperçu par URL **et** nouvelle action d'aperçu par connecteur hébergé (`faireApercuConnecteur`). |
| `src/business/importer/connect-relay.ts` | `StoreConnectorKey`, `url` facultative (obligatoire côté serveur pour PrestaShop), `connected`, `storeUrl`. |
| `src/business/importer/relay.ts` | `previewConnectedStore()` — aperçu Chariow **sans URL**. |
| `src/business/importer/StoreImportPanel.tsx` | Bloc Chariow : clé → connexion → aperçu ; état séparé de PrestaShop ; bandeau « brouillons écartés ». |
| `src/integrations/CatalogPage.tsx` | La fiche Chariow monte `ChariowConnectForm`. |
| `src/integrations/catalog.ts` | Fiche Chariow (`engine: 'api-key'`, capacités `catalog-read` + `inventory-read`). |
| `src/integrations/connections.ts`, `engine/registry.ts` | `chariow` déclaré (demandes d'activation + registre). |
| `tests/{integrations-catalog,integration-engine,integrations-unification}` | 26 → **27** fournisseurs ; parité catalogue/gestionnaires vérifiée automatiquement. |

### Artefacts Edge

| Fichier | sha256 | Taille |
| --- | --- | --- |
| `supabase/functions/_artifacts/store-connect.js` | `861a73b93f661379a7abcc6df07305ca303c8c65cbde6ba232a365a1172dc828` | 47 682 |
| `supabase/functions/_artifacts/store-import.js` | `d5b64d934663c0e70fd2c295e7f0c3eeed2ba35d53832c1462666194381ebe7f` | 89 753 |

Chargeurs épinglés sur `46a7e1b019991f6a5cc3efd43b5f010c05ac9917`
(et repinnés sur `46a7e1b…` — bundles identiques, seule l'épingle a changé).

---

## 2. Fonctions déployées

| Fonction | Version avant | Version après | `verify_jwt` | Bundle |
| --- | --- | --- | --- | --- |
| `store-connect` | v4 | **v5** | `true` | `861a73b9…` |
| `store-import` | v15 | **v16** | `true` | `d5b64d93…` |

Les deux sont `ACTIVE`, épinglées sur un commit précis, avec vérification de
taille **et** de SHA-256 avant exécution.

---

## 3. Migrations

`20261118160000_chariow_provider.sql` — **appliquée en base** :

```
provider_key | auth_mode | capabilities | implemented
chariow      | api-key   | {read}       | true
```

Vérifié en base : `bg_validate_connector_key('chariow')` → `chariow`.
Contrôles bloquants de la migration : refuse `write`/`modify`, refuse
`implemented = false`, refuse un `auth_mode` autre que `api-key`.

`prestashop` a aussi été passé à `implemented = true` : il l'était de fait
depuis la phase C, la table disait le contraire.

État de départ confirmé : `0` connexion Chariow, `0` vérification, `0` secret
Vault, `0` produit.

---

## 4. Tests

### Résultat global

```
npx vitest run     →  2270 / 2270      (140 fichiers)
npx tsc -b         →  vert
npx tsc -p tsconfig.edge.json --noEmit  →  vert
```

### Tests Chariow ajoutés (64)

**`chariow-catalog.test.ts` (44)**

| Ce que le test interdit | Statut |
| --- | --- |
| Importer un produit `draft` / `suspended` | ✅ |
| Compter un brouillon comme une erreur au lieu d'un écart | ✅ |
| Facteur 100 (unité principale prise pour mineure) | ✅ |
| Perdre l'arrondi XOF (`24,9` → **25 F**, pas 2 490) | ✅ |
| Fabriquer des variantes depuis `has_variant_pricing` | ✅ |
| Inventer un SKU | ✅ |
| Confondre stock inconnu (`null`) et rupture (`0`) | ✅ |
| Prendre `minimum_price` pour le prix d'un produit à prix libre | ✅ |
| Boucler sur un curseur qui ne progresse pas | ✅ |
| Transformer un 401 en « injoignable » | ✅ |
| Réessayer un 403 (action côté Chariow, pas panne) | ✅ |
| Accepter une image `http:`, `javascript:` ou `data:` | ✅ |
| Mettre la clé dans l'URL ou dans une réponse | ✅ |

**`chariow-connect.test.ts` (20)** — handlers réels, socket épinglé simulé :

| Garantie | Statut |
| --- | --- |
| La clé n'apparaît ni dans la réponse, ni dans un journal, ni dans la référence externe | ✅ |
| Un secret déposé est supprimé si l'enregistrement échoue | ✅ |
| Abonnement exigé **avant** tout appel réseau | ✅ |
| Entreprise vérifiée en base (sans droit d'écriture → aucun appel) | ✅ |
| Clé d'une **autre** boutique refusée (`SHOP_MISMATCH`, rien enregistré) | ✅ |
| 401 → `AUTH_INVALID` (401), 403 → `INSUFFICIENT_SCOPE` avec le scope nommé | ✅ |
| Aperçu : aucune écriture, produits `published` seuls, brouillons comptés | ✅ |
| « Tout en brouillon » → `CATALOG_EMPTY` expliquant **pourquoi** | ✅ |
| Confirmation explicite obligatoire (`CONFIRMATION_REQUIRED`), puis écriture unique | ✅ |
| `platformId` stable → `match: 'update'` sur un produit renommé | ✅ |
| Aucun identifiant d'écriture délivré par l'aperçu seul | ✅ |
| Origine inconnue → pas d'en-tête CORS (jamais `*`) | ✅ |

### Tests échoués

**Aucun** à la livraison. Trois tests de structure ont dû être mis à jour, et
c'est volontaire : ils comptaient 26 fournisseurs et un seul moteur écrit.

| Test | Avant | Après | Pourquoi |
| --- | --- | --- | --- |
| `integrations-unification` | `INTEGRATIONS` = 26 | **27** | Chariow ajouté au catalogue. |
| `integration-engine` | 26 clés | **27** | Registre aligné sur le catalogue. |
| `integrations-catalog` | moteurs écrits = `{prestashop}` | `{prestashop, chariow}` | Chariow a un moteur réel — et le test vérifie désormais que `'chariow'` figure dans **les deux** gestionnaires déployés, pour qu'une fiche ne puisse pas annoncer un moteur absent. |

Les 4 échecs de parité d'artefact, constatés en cours de route, étaient
attendus (code Edge modifié) et ont été résolus par la reconstruction des
bundles.

---

## 5. Comment le connecteur fonctionne réellement

### Ce qui distingue Chariow des connecteurs existants

| | Shopify / Woo | PrestaShop | **Chariow** |
| --- | --- | --- | --- |
| Catalogue public | oui | non | **non** |
| Hôte interrogé | la boutique | la boutique | **`api.chariow.com`, fixe** |
| Pagination | offset | `limit=offset,n` | **curseur** |
| Total annoncé | oui | `Content-Range` | **non** |
| Variantes | liste | liste | **booléen seul** |
| SKU | oui | oui | **non** |

**Conséquence SSRF** : l'hôte de l'API ne vient jamais de la requête. Il n'y a
donc pas d'adresse arbitraire à épingler — mais la sortie reste la sortie
épinglée commune, qui revalide la résolution de `api.chariow.com` à chaque
appel. La surface n'est pas supprimée, elle est **réduite à un nom connu
d'avance**.

**Le contrôle qui compte** : `GET /v1/store` renvoie `data.url`. Si le marchand
a saisi une adresse de vitrine et qu'elle ne correspond pas, la connexion est
**refusée** (`SHOP_MISMATCH`, 409). Sans ce contrôle, une clé d'une autre
boutique serait acceptée et l'import écraserait le catalogue de la mauvaise
entreprise.

### Le parcours complet, déjà branché

```
1. Carte Chariow dans le catalogue        →  ChariowConnectForm
2. Clé saisie (type=password, 1 champ)    →  store-connect { action: connect }
3. Serveur : GET /v1/store, GET /v1/products (per_page=1)
   → preuve de store.read ET products.read
4. Clé déposée dans Vault (vyora_chariow_{userId}), effacée du composant
5. integration_connections ← chariow / connected / external_account_ref = URL boutique
6. « Prévisualiser le catalogue »         →  store-import { action: preview, connectorKey: 'chariow' }
7. Serveur : clé relue dans Vault, catalogue paginé, filtre published, brouillons comptés
8. normalizeCatalog → matchBatch → aperçu (aucune écriture)
9. Confirmation explicite + previewId     →  store-import { action: import, confirmed: true }
10. insertProducts (mise à jour si platformId connu) + historique + progression
11. Reprise : { action: resume, importKey } relit ce qui est déjà écrit
```

**Aucun second moteur d'import** : `normalizeCatalog`, `matchBatch`,
`isImportable`, `insertProducts`, la reprise, l'historique et le journal de
progression sont les composants communs, inchangés dans leur logique.

---

## 6. Ce qui n'est PAS encore fait

1. **Aucun test authentifié.** Il faut votre clé. C'est le seul point bloquant.
2. **Aucun import réel lancé**, et je n'en lancerai pas sans votre accord
   explicite — l'aperçu, lui, n'écrit rien.
3. **Variantes Chariow** : l'API ne publie qu'un booléen. Les produits à tarifs
   par variante sont importés comme des **fiches simples**, avec un
   avertissement visible dans l'aperçu. Ce n'est pas un défaut du connecteur,
   c'est une limite de l'API.
4. **Aucun SKU** : le rapprochement se fait sur `prd_…` (stable), puis sur
   l'empreinte du nom. Aucune référence inventée.
5. **Pas de webhook / temps réel** : Chariow « Pulses » concerne des événements
   de vente, hors périmètre lecture seule. L'import reste à la demande.
6. **`api.staging.chariow.com`** mentionné dans une page de bonnes pratiques :
   non câblé, non vérifié.
7. **Netlify : 0 crédit** — aucun déploiement front, aucune Deploy Preview.

---

## 7. Instructions pour le test réel

### Étape 1 — créer la clé (2 minutes)

1. `https://app.chariow.com` avec le compte propriétaire de
   `ewbnibvk.mychariow.online`.
2. **Settings → API Keys → Create API Key**.
3. Nom : `vyora-import-readonly`.
4. Scopes : **cocher uniquement `products.read` et `store.read`.**
   Ne rien cocher d'autre — en particulier aucun `customers.*`, `sales.*`,
   `*.write`.
5. Copier la clé `sk_live_…` immédiatement (affichée **une seule fois**).

### Étape 2 — connecter dans VYORA

1. Ouvrir VYORA → **Intégrations** → catégorie **Boutiques en ligne** → **Chariow**.
2. Sélectionner l'entreprise (abonnement Business Ground actif requis).
3. Coller la clé dans le champ `sk_live_…`, puis **« Vérifier et connecter »**.
4. La fiche affiche la **preuve** : nom de la boutique, URL lue chez Chariow,
   statut, ressources lues (`store`, `products`), hôte contacté
   (`api.chariow.com`). La clé est effacée du champ et rangée dans Vault.

> La clé ne doit **jamais** être collée dans cette conversation, un fichier du
> dépôt ou un journal. Si elle l'a été, révoquez-la et créez-en une autre.

### Étape 3 — prévisualiser (n'écrit rien)

Dans le même écran, ou dans **Import & Connect**, bloc **« Boutique Chariow »** :
**« Prévisualiser le catalogue »**.

L'aperçu affiche, pour chaque produit : nom, prix formaté dans sa devise,
identifiant stable, avertissements, décision de rapprochement, et un bandeau
« N produit(s) non publié(s) ont été écartés ».

**C'est à cette étape que le nombre réel de produits apparaît.** Il n'a jamais
été mesuré : la vitrine n'expose rien publiquement.

### Étape 4 — me transmettre le résultat

Copiez-moi le résumé de l'aperçu (nombre de produits, nombre de brouillons
écartés, devise, éventuels avertissements). **Pas la clé.** J'exploiterai ces
chiffres pour le test authentifié et la mise à jour du rapport.

### Étape 5 — import définitif

Uniquement après **votre** confirmation explicite. À ce moment :
sélection des produits → confirmation → écriture → historique → possibilité de
reprendre un import interrompu.

### Si quelque chose échoue

| Symptôme affiché | Cause | Correction |
| --- | --- | --- |
| « clé … commence par sk_ » | clé incomplète ou d'un autre type | recopier la clé entière |
| `AUTH_INVALID` (401) | clé supprimée, révoquée, ou créateur retiré de l'équipe | créer une nouvelle clé |
| `INSUFFICIENT_SCOPE` (403) | scope manquant | cocher `products.read` **et** `store.read` sur la clé existante, sans la régénérer |
| `SHOP_MISMATCH` (409) | la clé appartient à une autre boutique | vérifier la boutique dans Settings |
| `CATALOG_EMPTY` avec « N brouillon(s) » | tous les produits sont non publiés | publier dans Chariow, puis relancer |
| `CONNECTION_REQUIRED` (409) | aucune clé en Vault | reconnecter la boutique |
