# Audit — système universel de connexion aux boutiques e-commerce

**Date** : 14 novembre 2026
**Branche** : `arena/0188834f-saas-ugc`
**Objet** : établir ce qui est **réellement** implémenté, avant toute modification.

> Règle appliquée à ce document : une plateforme n'est `implemented` que si son
> code de connexion **et** de lecture du catalogue existent, sont branchés dans
> les deux Edge Functions déployées, et sont couverts par des tests. Un nom dans
> le catalogue n'est pas une preuve.

---

## 1. Inventaire réel du catalogue (27 fournisseurs)

| Fournisseur | `engine` catalogue | Branché `store-connect` | Branché `store-import` | Verdict |
| --- | --- | --- | --- | --- |
| **PrestaShop** | `api-key` | ✅ | ✅ | **Implémenté** |
| **Chariow** | `api-key` | ✅ | ✅ | **Implémenté** |
| Shopify | `null` | ❌ | partiel (catalogue public) | **Partiel** |
| WooCommerce | `null` | ❌ | partiel (catalogue public) | **Partiel** |
| OpenCart | `null` | ❌ | ❌ | **Déclaré, non fonctionnel** |
| Magento | `null` | ❌ | ❌ | **Déclaré, non fonctionnel** |
| Wix, BigCommerce, Squarespace, Ecwid | `null` | ❌ | ❌ | **Déclaré, non fonctionnel** |
| Meta/TikTok/LinkedIn/Pinterest/YouTube | `null` | ❌ | — | Hors périmètre boutique |
| Gmail/Drive/Calendar/M365/Outlook/Slack/Notion/HubSpot/Stripe/Saspay/Odoo | `null` | ❌ | — | Hors périmètre boutique |

### Nuance importante sur Shopify et WooCommerce

Ils ne sont **pas** « non implémentés ». L'import lit réellement leur
**catalogue public** :

- Shopify : `GET /products.json?limit=250`
- WooCommerce : `GET /wp-json/wc/store/v1/products?per_page=100`

Ce qui manque n'est pas la lecture, c'est le **parcours de connexion** : aucune
clé, aucun Vault, aucun état de connexion. Ce sont donc des sources
*anonymes*, pas des connexions authentifiées. Leur `engine: null` est **exact**
et doit le rester tant qu'aucune authentification n'existe.

---

## 2. Correction d'une déclaration devenue fausse

`prestashop` et `chariow` avaient `implemented = true` dans
`saas_business.integration_providers`, et `capabilities = ['read','write','modify']`
pour PrestaShop.

**C'était faux** : `store-connect` n'effectue **que des `GET`**, et son
`pinnedFetchLike` refuse toute méthode autre que `GET` :

```ts
// supabase/functions/store-import/safe-egress.ts
if (method !== 'GET') {
  throw new Error('Méthode non autorisée sur la sortie réseau de l’import.');
}
```

Aucune capacité d'écriture n'existe dans le code. Déclarer `write`/`modify`
promettait une chose que rien n'implémente. **Corrigé** : `['read']` pour les
deux, avec une migration qui refuse désormais cette incohérence.

---

## 3. OpenCart — vérification de l'API officielle

**Résultat de la vérification** (documentation officielle + forum OpenCart) :

- L'API « utilisateur système » d'OpenCart **n'est pas REST**. Elle exige un
  `POST index.php?route=api/login` qui ouvre une **session par cookie**, puis
  un `api_token` à passer **en paramètre d'URL** sur chaque appel.
- **Il n'existe aucune route `api/products` en cœur d'OpenCart 3.**
  (Citation directe de la documentation communautaire : *« There is no route for
  api/products »*.) Les routes livrées couvrent le panier, les coupons, le
  client, le paiement — pas le catalogue.
- Lire un catalogue OpenCart exige donc soit une **extension tierce payante**
  (dont le format de réponse varie d'un éditeur à l'autre), soit un **contrôleur
  personnalisé installé chez le marchand**.

**Décision** : OpenCart **n'entre pas** dans le connecteur natif. Deux raisons
qui ne sont pas des préférences :

1. **Un cookie de session est un secret qui se renouvelle.** Stocker un cookie
   dans Vault ne suffit pas : il faut rejouer `api/login` à chaque expiration,
   ce qui suppose de conserver aussi le **mot de passe** du compte API. C'est une
   surface d'attaque très supérieure à une clé révocable, pour un gain nul.
2. **`api_token` en paramètre d'URL** finit dans les journaux d'accès du serveur
   du marchand. Cela contredit directement la règle « aucun secret dans les
   logs » — y compris chez un tiers.

OpenCart sera donc servi par le **connecteur API personnalisée** (Phase D), avec
la marche à suivre documentée : installer une route JSON chez le marchand.
Prétendre le contraire serait exactement ce que la consigne interdit.

---

## 4. Marketoo — la plateforme n'existe pas sous ce nom

**Vérification** : il n'existe aucune plateforme e-commerce nommée « Marketoo ».
Deux homonymes ont été écartés :

- **Marketo / Adobe Marketo Engage** : automatisation marketing B2B (leads,
  campagnes). Aucun catalogue produit. Hors périmètre.
- **Maketou** (`maketou.com`, aussi écrit *Marketou*) : plateforme de vente de
  **produits numériques**, très présente en Afrique de l'Ouest, devise **XOF**.
  C'est presque certainement la plateforme visée.

### Ce que l'API publique de Maketou expose réellement

Documentation officielle `docs-api.maketou.com`, base `https://api.maketou.net`,
`Authorization: Bearer`.

| Endpoint | Méthode | Existe ? |
| --- | --- | --- |
| `/api/v1/stores/cart/checkout` | POST | ✅ créer un panier |
| `/api/v1/stores/cart/{id}` | GET | ✅ **statut d'un panier** |
| Clé de signature des webhooks | GET | ✅ (public, sans clé) |
| **Lister les produits** | GET | ❌ **absent** |
| **Lire le catalogue** | GET | ❌ **absent** |
| **Lister les commandes** | GET | ❌ **absent** |

La documentation l'énonce elle-même : *« l'API publique de Maketou pour créer
des paniers, initier des paiements et suivre leur statut »*. Le SDK
communautaire le confirme : *« The current public Maketou API documents two
server-side operations »*.

**Conclusion, et c'est la découverte importante de cet audit** : Maketou est une
plateforme **de paiement**, pas une plateforme dont le catalogue est
interrogeable. **Un connecteur d'import est impossible aujourd'hui** — non par
manque de travail, mais parce que l'API ne publie aucun catalogue.

L'implémenter quand même reviendrait à inventer des endpoints, ce que la
consigne interdit explicitement.

**Ce qui est fait à la place** : Maketou est déclaré dans le catalogue comme
**destination de paiement** (`engine: null`, capacités `checkout` uniquement),
avec la limitation écrite noir sur blanc. Aucun bouton de connexion mort.

---

## 5. Ce qui existe déjà et doit être réutilisé

| Composant | État | Réutilisation |
| --- | --- | --- |
| `integration_connections` + `integration_providers` | ✅ | Source de vérité des états |
| `bg_connect_integration` / `bg_record_integration_failure` / `bg_disconnect_integration` | ✅ | Inchangées |
| Vault (`vault.create_secret` / `update_secret` / `decrypted_secrets`) | ✅ | Inchangé |
| `bg_import_access` (Business Grow) / `bg_require_workspace` | ✅ | Inchangé |
| `safe-egress.ts` + `pinned-fetch.ts` | ✅ | **À étendre** : en-têtes supplémentaires |
| `normalize.ts` / `pipeline.ts` (`normalizeCatalog`) | ✅ | Inchangé |
| `matching.ts` (`matchBatch`) | ✅ | Inchangé |
| `resume.ts`, historique, progression | ✅ | Inchangés |
| `url-guard.ts` (SSRF) | ✅ | Inchangé, **à durcir** pour l'API libre |

---

## 6. Écarts identifiés, par ordre d'impact

1. **Un seul formulaire par plateforme** (`PrestashopConnectForm`,
   `ChariowConnectForm`) : aucune notion déclarative d'« exigences
   d'identification ». Ajouter un fournisseur = écrire un composant React.
   → **Phase A** : `connector-requirements.ts`, formulaire générique.
2. **États de connexion incomplets** : pas de distinction entre *non configuré*,
   *expiré* et *autorisation insuffisante* côté formulaire.
   → **Phase A**.
3. **Aucun moyen de connecter une API REST non répertoriée** : c'est le trou le
   plus large du produit, et le sujet de la demande.
   → **Phase D**.
4. **Aucune vue « Mes boutiques connectées »** : l'état est dispersé dans les
   fiches.
   → **Phase E**.
5. **Sortie réseau limitée à `Authorization`** : un connecteur générique doit
   pouvoir envoyer d'autres en-têtes (`X-Api-Key`, `X-Shopify-Access-Token`…).
   → **Phase D**, avec liste blanche stricte.
6. Capacités PrestaShop/Chariow surdéclarées (`write`/`modify`).
   → **Phase B**, déjà corrigé.

---

## 7. Plan retenu

| Phase | Contenu | Blocage |
| --- | --- | --- |
| **A** | Exigences déclaratives par connecteur, formulaire générique, états complets, transport en-têtes | aucun |
| **B** | Stabilisation : capacités réelles, cohérence catalogue/registre/base | aucun |
| **C** | OpenCart → **documenté comme non supporté nativement**, servi par la Phase D. Maketou → **déclaré payeur uniquement** | dépend d'API tierces absentes |
| **D** | Connecteur API personnalisée (REST, OpenAPI, mapping, pagination, SSRF durci) | aucun |
| **E** | Centre « Mes boutiques connectées » + tests de bout en bout | aucun |

Aucune clé API de votre part n'est nécessaire pour A, B, D et E. La Phase C
est **bloquée par des API qui n'existent pas**, pas par des identifiants : si
vous avez un accès documenté à une API catalogue Maketou ou à une extension
OpenCart précise, c'est ce qu'il faut me transmettre.
