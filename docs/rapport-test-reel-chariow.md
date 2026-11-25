# Rapport — test réel de connexion SORAHNEX × boutique Chariow

**Boutique testée** : `https://ewbnibvk.mychariow.online`
**Date** : 14 novembre 2026
**Branche** : `arena/0188834f-saas-ugc`
**Connecteur Shopify** : **non utilisé**, conformément à la consigne.

---

## 0. Conditions du test (à lire avant les neuf points)

L'environnement d'exécution de cette session **n'a aucune route sortante** : toute
requête `curl` vers la boutique, `chariow.com`, `api.chariow.com` ou
`*.supabase.co` renvoie `000` (échec de connexion, pas un refus applicatif). Les
constats ci-dessous proviennent donc de deux sources, toujours distinguées :

| Source | Ce qu'elle prouve |
| --- | --- |
| Lecture HTTP réelle de la vitrine et de l'API, via la passerelle de récupération hors sandbox | Le comportement **effectif** des serveurs Chariow (codes HTTP, corps de réponse) |
| Documentation officielle `chariow.dev` | Le **contrat** de l'API (champs, scopes, pagination, limites) |

Aucun appel HTTP n'a été prétendu venir de SORAHNEX elle-même : les Edge Functions
`store-connect` / `store-import` n'ont pas pu joindre Chariow depuis le sandbox.
La distinction est maintenue partout dans ce rapport ; le point 4 en tire les
conséquences.

---

## 1. Accessibilité de la boutique

**La vitrine est accessible et répond.** Contenu réellement observé :

- Titre : **SBC AI AGENCY** ; accroche « Dev founder SaaS et entrepreneur digital ».
- Navigation : `Products` → `/`, `Affiliation` → `/affiliation`, `About`, `Contact`.
- Sélecteur de pays/devise : **United States ($)** par défaut ; interface en anglais.
- Portail client : « See my orders » → `https://app.ateliat.com/`.
- Pied de page : « SBC AI AGENCY ©2026 » + **« Powered by Chariow »**.
- `sitemap.xml` : **7 URL, toutes statiques** — `/`, `/about`, `/contact`,
  `/legal-notice`, `/privacy-policy`, `/terms-of-service`, `/help`.
- `/products.json` : **réponse vide** (aucun catalogue de type Shopify).
- Page d'accueil : **aucune fiche produit**, aucun prix, aucun bouton d'achat.

Conclusion du point : la boutique est **publique et lisible**, mais elle
**n'expose publiquement aucun article**.

## 2. Identification de la plateforme

**Plateforme réelle : Chariow.** Faisceau de preuves convergentes :

1. Pied de page explicite : « Powered by **Chariow** » (lien `chariow.com`).
2. Assets servis depuis `cdn.axazara.com`, domaine d'infrastructure Chariow.
3. Portail de commandes `app.ateliat.com`, également l'infrastructure Chariow.
4. Jeu de routes caractéristique (`/affiliation`, `/help`, `/legal-notice`,
   `/terms-of-service`, sitemap statique).
5. L'API du fournisseur répond bien sur `api.chariow.com`.

**Ce n'est pas Shopify** (aucun `/products.json`, aucun `cdn.shopify.com`, aucun
`/collections/…`, aucun `Shopify.theme`), ni PrestaShop, ni WooCommerce.

**Fonctionnement** : Chariow est une plateforme d'hébergement de boutiques
(produits numériques : formations, licences, coaching, services, bundles). La
vitrine est rendue **côté serveur/JS à partir d'une base interne** ; il n'existe
**aucun fichier catalogue public** (pas de JSON, pas de XML, pas de flux). Le
catalogue n'est donc interrogeable que par **l'API officielle authentifiée**.

## 3. API officielle, authentification, données exigées

| Élément | Valeur constatée |
| --- | --- |
| Base | `https://api.chariow.com/v1` |
| Documentation | `https://chariow.dev` (spec OpenAPI : `/api-reference/openapi.json`) |
| Authentification | `Authorization: Bearer sk_live_…` (clé d'API, **pas** d'OAuth) |
| Création de la clé | `app.chariow.com` → **Settings → API Keys** (affichée une seule fois) |
| Scopes utiles à SORAHNEX | **`products.read`** et **`store.read`** — rien d'autre |
| Scopes à ne PAS demander | `customers.read`, `customers.pii.read`, `sales.read`, `licenses.write`, `discounts.read`, `webhooks.write`, `checkout.write` |
| Points d'entrée lecture | `GET /v1/store`, `GET /v1/products`, `GET /v1/products/{id\|slug}` |
| Pagination | **curseur** : `?per_page=` (≤ 100) + `?cursor=` ; réponse `{data:[…], pagination:{next_cursor, has_more_pages, count, per_page}}` |
| Filtres utiles | `search`, `category`, `type` |
| Limite de débit | 100 req/min par clé ; en-têtes `X-RateLimit-*`, `Retry-After` sur 429 |
| Erreurs | `401` clé absente/invalide ; `403 insufficient_scope` (scopes manquants listés dans `errors.scopes` et `WWW-Authenticate`) |

Toutes les routes utiles sont **en lecture seule**. Aucun scope d'écriture
n'est nécessaire, ce qui aligne l'intégration sur la contrainte « lecture seule ».

## 4. Tentative de connexion réelle

**Test effectué** : `GET https://api.chariow.com/v1/products` **sans en-tête
d'autorisation**.

**Résultat obtenu** — HTTP **401** :

```json
{"message":"API key is missing. Please provide a valid API key. Help: https://docs.chariow.com","errors":[]}
```

**Interprétation** : Chariow **refuse tout accès anonyme au catalogue**. Aucun
contournement n'a été tenté ni ne sera tenté (pas de scraping de la vitrine, pas
de devinette de clé, pas d'endpoint non documenté). La conséquence est nette :
**une connexion réelle est impossible sans clé d'API**, et c'est le seul
mécanisme officiel.

**Ce qu'il faut fournir, précisément** :

1. Se connecter à `https://app.chariow.com` avec le compte propriétaire de
   `ewbnibvk.mychariow.online`.
2. **Settings → API Keys → Create API key**.
3. Cocher **uniquement** : `products.read` et `store.read`. Ne rien cocher
   d'autre (en particulier aucun scope `customers.*`, `sales.*`, `*.write`).
4. Donner un nom parlant (ex. `vyora-import-readonly`).
5. Copier la clé `sk_live_…` — elle n'est **plus jamais réaffichée** — et la
   saisir **directement dans le formulaire du connecteur SORAHNEX**.

> **La clé ne doit jamais transiter par la conversation, un journal ou un
> fichier du dépôt.** Le formulaire la transmet à `store-connect`, qui la stocke
> dans **Vault Supabase** sous `vyora_chariow_{userId}`. Si la clé a déjà été
> collée quelque part, la révoquer puis en créer une autre.

## 5. Catalogue réellement accessible

**Sans authentification : 0 produit.**

| Vérification | Résultat |
| --- | --- |
| `sitemap.xml` (URL produits) | **0** — 7 URL statiques seulement |
| Page d'accueil / onglet « Products » | **0 fiche produit**, 0 prix |
| `/products.json` (style Shopify) | Vide, non exploitable |
| `GET /v1/products` sans clé | **401** — accès refusé |
| Autre surface publique (flux RSS/XML/JSON) | Aucune détectée |

**Avec une clé `products.read`, l'API renvoie l'intégralité du catalogue du
compte — y compris les brouillons** (`status: draft|published|suspended`). Ce
point a une conséquence de conception : l'import SORAHNEX devra **filtrer sur
`published`** et signaler séparément le nombre de brouillons ignorés, pour ne
jamais publier dans SORAHNEX un article non publié chez le marchand.

## 6. Nombre de produits et de variantes réellement détectés

- **Produits détectés dans la surface publique : 0.**
- **Variantes détectées : 0.**

**Mise en garde explicite** : ces zéros mesurent **ce que la boutique expose
sans authentification**, et **non** la taille réelle du catalogue. La vitrine
étant vide, la lecture seule ne permet pas de distinguer trois hypothèses :

1. la boutique est neuve et n'a réellement aucun produit ;
2. les produits existent mais sont tous en **brouillon** ;
3. les produits sont publiés mais la vitrine ne les affiche pas (configuration
   de thème, page d'accueil éditoriale).

Seule la clé `products.read` tranchera. Le décompte définitif sera produit par
le test authentifié, avec la répartition `published` / `draft` / `suspended`.

## 7. Champs réellement récupérables, et leur destination dans SORAHNEX

Contrat relevé sur la documentation officielle (produit) ; chaque champ est
mis en face de son équivalent dans `NormalizedProduct`.

| Champ Chariow | Type / remarque | Destination SORAHNEX |
| --- | --- | --- |
| `id` (`prd_…`) | **stable** | `platformId` (identité inter-imports) |
| `name` | chaîne | `name` |
| `description` | **HTML assaini** | `description` (nettoyée par `normalize`) |
| `slug` | chaîne | `productUrl` = `https://<boutique>/<slug>` (à confirmer en réel) |
| `type` | `downloadable\|course\|license\|service\|bundle\|coaching` (**mutable**) | métadonnée, pas une identité |
| `category{value,label}` | objet | `categories[]` |
| `status` | `draft\|published\|suspended` | **filtre d'import** (ne garder que `published`) |
| `is_free` | booléen | cohérence prix (`priceMinor = 0`) |
| `pictures.thumbnail`, `pictures.cover` | **2 images maximum** | `imageUrl` (`cover` sinon `thumbnail`), contrôle `https` public |
| `pricing.type` | `one_time\|what_you_want\|free` | règle de prix |
| `pricing.price`, `current_price`, `sale_price`, `effective`, `minimum_price`, `suggested_price` | `{value, formatted, short, currency}` — `value` **décimal** | `priceMinor = round(value × 100)`, `currency` |
| `pricing.tracking{currency,value}` | devise de référence (USD) | arbitrage de devise |
| `pricing.price_off` | remise | métadonnée d'affichage |
| `quantity{value, remaining{value,percent}, sold{value,percent}, total}` | `null` possible | `stock` (`null` = inconnu, jamais 0) |
| `has_variant_pricing` | **booléen seul** | `variants[]` = vide + avertissement explicite |
| `settings.is_shipping_address_required` | booléen | métadonnée |
| `rating{total_ratings, thumbs_up_count, thumbs_up_percentage}` | objet | métadonnée |
| `sales_count`, `on_sale_until` | entier / date | métadonnées |
| `bundle{value, savings{amount,percentage}}`, `coaching` | objets | métadonnées |
| `seo`, `fields`, `store` | **toujours `null`** | ignorés |
| **SKU / référence** | **absent de l'API** | `sku = null` (jamais inventé) ; rapprochement par `platformId` puis empreinte nom |
| `GET /v1/store` | `id`, `name`, `description`, `logo_url`, `url`, `social_links`, `status`, `stats.total_customers`, `stats.ratings` | identification de la connexion (`external_account_ref`, libellé de la fiche) |

**Bilan de couverture** : noms, descriptions, identifiants stables, prix,
devises, stock, images, catégories, pagination — **oui**. Variantes détaillées
et références SKU — **non**.

## 8. Limitations constatées

1. **Aucune énumération des variantes.** `has_variant_pricing` est un booléen :
   le prix d'une option n'est pas exposé, ni son stock, ni son identifiant.
   Conséquence : un produit à variantes s'importe comme **un produit simple**
   (prix « à partir de »), avec un avertissement visible dans l'aperçu.
2. **Aucun SKU / référence.** Le rapprochement se fait sur `id` Chariow
   (stable) puis sur l'empreinte nom — jamais sur une référence inventée.
3. **Deux images maximum** par produit (`thumbnail`, `cover`).
4. **Prix en décimal**, pas en unité mineure : la conversion ×100 doit être
   faite une seule fois et arrondie, sinon on reproduit le double-arrondi déjà
   corrigé côté PrestaShop.
5. **Les brouillons sont renvoyés** par l'API : sans filtre `status`, SORAHNEX
   importerait des fiches non publiées.
6. **Accès strictement conditionné à une clé.** Aucun catalogue public, aucun
   flux : pas de mode « catalogue public » à implémenter, contrairement aux
   moteurs `public-json` / `public-xml`.
7. **Clé en clair obligatoire** (`sk_live_…`) : elle doit rester dans Vault, ne
   jamais apparaître dans un log, une réponse d'API ou le bundle client.
8. **100 requêtes/minute** : l'import doit paginer par curseur (`per_page` ≤ 100)
   et respecter `Retry-After`.
9. **Pas de test authentifié possible dans ce sandbox** (aucune route sortante).
   Le test réel devra être exécuté depuis l'Edge Function déployée, avec la clé
   fournie par l'utilisateur.
10. **Environnement `api.staging.chariow.com`** mentionné dans la doc « best
    practices » : **non confirmé**, à ne pas câbler avant vérification.
11. **Écriture impossible par conception** : les scopes retenus sont en lecture
    seule. Les capacités déclarées pour Chariow devront donc être `read`
    uniquement — pas de `write`/`modify` comme pour PrestaShop.
12. **Netlify : 0 crédit** — aucun déploiement front n'a été effectué ni ne le
    sera sans signalement préalable.

## 9. Ce qui reste à développer

Rien n'a été codé pour Chariow à ce stade (`grep -ri chariow` sur le dépôt :
**aucune occurrence** ; la ligne `chariow` **n'existe pas** dans
`saas_business.integration_providers`, et `StorePlatform` ne la connaît pas).
Le plan de raccordement, qui **réutilise le moteur existant** et n'introduit
**aucun second moteur d'import** :

**A. Déclaration (données)**
- Migration `INSERT` dans `integration_providers` : `provider_key = 'chariow'`,
  `auth_mode = 'api-key'`, `capabilities = ['read']`, `implemented = true`.
- `StorePlatform` += `'chariow'`, `PLATFORM_LABELS`, et l'entrée dans
  `CatalogPlatform`.

**B. Client d'API — `src/business/importer/chariow-api.ts`**
- `Authorization: Bearer` depuis Vault uniquement ;
- pagination curseur, `per_page` borné à 100, respect de `Retry-After` ;
- remontée du **vrai statut HTTP** (401 clé révoquée ≠ 502), `403` →
  `insufficient_scope` avec les scopes manquants, message actionnable ;
- hôte **fixe** `api.chariow.com` : pas d'URL fournie par l'utilisateur, donc
  surface SSRF réduite au minimum (l'origine boutique ne sert qu'à l'identification).

**C. Catalogue — `src/business/importer/chariow-catalog.ts`**
- `probeChariow` : `GET /v1/store` + `GET /v1/products?per_page=1` (preuve de
  scope, pas seulement de connectivité) ;
- `readChariowCatalog` : itération curseur, filtre `status = 'published'`,
  comptage des brouillons écartés ;
- projection vers `NormalizedProduct` : `platformId = id`, `sku = null`,
  `priceMinor` arrondi depuis `pricing.effective ?? current_price ?? price`,
  `imageUrl = cover ?? thumbnail`, `stock = quantity.remaining.value ?? null`,
  `variants = []` + avertissement si `has_variant_pricing`.

**D. Raccordement Edge Functions (réutilisation, pas duplication)**
- `store-connect` : ajouter `chariow` à `CONNECTEURS` avec `platform: 'chariow'` ;
  la sonde réutilise `verifierCible`/`bg_connect_integration` tels quels ; pas
  d'URL de boutique à saisir (la clé seule suffit, l'origine est déduite de
  `GET /v1/store`.url et confirmée par l'appelant) ;
- `store-import` : brancher `chariow` sur `readChariowCatalog` en respectant le
  pipeline commun — normalisation → rapprochement (`match: create|update|
  ambiguous|duplicate-in-batch`) → **aperçu avant import** → **confirmation
  explicite** → **reprise idempotente** (`product_facts.platform_id`) →
  **historique** (`import_runs` + `integration_connection_checks`) ;
- coffre : `vyora_chariow_{userId}` ; déconnexion = ligne `disconnected`
  **puis** suppression du secret ;
- garde-fous conservés : abonnement Grow, isolation des entreprises,
  sortie épinglée SSRF.

**E. Interface**
- Fiche `chariow` dans `src/integrations/catalog.ts` (catégorie `commerce`,
  capacité `catalog-read`, `inventory-read`), état dérivé — jamais saisi ;
- `ChariowConnectForm` sur le modèle de `PrestashopConnectForm` **sans champ
  URL** (un seul champ : la clé), avec la mention des scopes exacts et le
  rappel « clé affichée une seule fois ».

**F. Vérification**
- Fixtures + tests unitaires (pagination, filtre brouillons, arrondi de prix,
  401/403, `has_variant_pricing`) ;
- reconstruction des artefacts Edge + épinglage (`scripts/build-edge-artifact.mjs`) ;
- **test réel authentifié** avec la clé fournie : `GET /v1/store`, puis import
  complet paginé, avec décompte `published` / `draft` — c'est ce test qui
  produira le chiffre définitif du point 6.

**Prérequis bloquant pour la suite** : la clé `sk_live_…` avec **`products.read`
+ `store.read`**, saisie dans le formulaire SORAHNEX (point 4). Sans elle, tout ce
qui précède le point 8 peut être développé et testé hors ligne, mais **aucun
import réel n'est possible**.
