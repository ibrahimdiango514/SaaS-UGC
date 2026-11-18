# Mise en service Meta — procédure exacte, étape par étape

> **État au 2026-11-14.** Cette procédure s'applique à l'application Meta **VYORA**
> (App ID `1692282959171281`, type Business, mode Développement) et au projet Supabase
> `xbuuhfwobrafcbgtdgjx`.
>
> **Aucune connexion Meta n'a encore été réalisée.** Tant que ce document n'est pas coché de bout
> en bout, aucune fiche ne doit être présentée comme opérationnelle. Les cases se cochent au fur et
> à mesure des preuves, pas des intentions.
>
> **Règle de manipulation** : aucun App Secret, aucun jeton, aucun Verify Token ne doit passer par
> un chat, un ticket, un commit ou une capture d'écran. Tous se saisissent directement dans
> **Supabase → Edge Functions → Secrets** ou dans la console Meta.

---

## 0. Ce qui est déjà fait, et ce qui ne l'est pas

| Élément | État réel |
| --- | --- |
| Base de données Meta (6 tables, 21 fonctions) | **Appliquée en production**, recettes d'isolation exécutées |
| Code des Edge Functions `meta-connect`, `meta-webhook` | Écrit, typé, testé — **jamais exécuté dans Deno réel** |
| Artefacts + chargeurs épinglés | **Préparés dans le dépôt** ; l'épingle reste à poser sur le commit de l'artefact (§0.4 bis du document de test réel) |
| Edge Functions déployées sur le projet | **NON — aucune fonction `meta-*` n'existe en production** |
| Secrets `META_*` sur le projet | **NON — aucun secret `META_*` n'est posé** |
| Application Meta (App ID, type Business) | **Oui, créée par vous**, mode Développement |
| Connexion Facebook Page | **NON** |
| Publication réelle sur une Page | **NON** |
| Connexion WhatsApp Business | **NON** |
| Message WhatsApp envoyé/reçu | **NON** |

L'état « aucune fonction `meta-*` déployée » et « aucun secret `META_*` » a été vérifié sur le
projet de production, pas supposé.

---

## 1. Paramètres exacts à renseigner dans Meta

Chemin : **developers.facebook.com → Mes applications → VYORA → Paramètres de l'application →
Paramètres de base**.

| Champ | Valeur exacte |
| --- | --- |
| Nom d'affichage | `VYORA` |
| Contact (e-mail) | votre adresse d'administration |
| URL de la politique de confidentialité | `https://vyora-saas-ugc.netlify.app/confidentialite` |
| URL des conditions d'utilisation | `https://vyora-saas-ugc.netlify.app/conditions` |
| URL des instructions de suppression des données | `https://vyora-saas-ugc.netlify.app/confidentialite#suppression-des-donnees` |
| Catégorie | Entreprise / Logiciel de gestion d'entreprise |
| Domaines de l'application | `vyora-saas-ugc.netlify.app` |
| Icône | 1024 × 1024 px |
| Mode | **Développement** (ne pas passer en Live avant l'étape 6) |

Les trois URL ci-dessus existent réellement dans l'application : la politique de confidentialité
contient une section « Intégrations Meta » et une section « Suppression des données » ancrée
(`#suppression-des-donnees`), qui décrit la déconnexion réelle (jeton effacé + révocation chez
Meta). C'est exactement ce que Meta vérifie.

**Domaines autorisés** (Facebook Login for Business → Paramètres → Paramètres OAuth du client) :

```
vyora-saas-ugc.netlify.app
xbuuhfwobrafcbgtdgjx.supabase.co
localhost
```

`localhost` sert uniquement au développement local ; il peut être retiré plus tard.

Interrupteurs à mettre sur **Oui** :

- Connexion OAuth client
- Connexion OAuth Web
- Appliquer HTTPS
- **Connexion OAuth du navigateur intégré**
- **Utiliser le mode strict pour les URI de redirection**
- **Connexion avec le SDK JavaScript**

Les deux derniers en gras sont indispensables : sans eux, l'Embedded Signup WhatsApp ne peut pas
s'ouvrir et le SDK ne peut pas rendre le `code` à la fenêtre appelante.

---

## 2. URL de redirection et de webhook

Ces URL sont **dérivées du code**, pas inventées : l'URI de redirection est construite par
`callbackUri()` à partir de `SUPABASE_URL`, et l'URL de webhook correspond au nom de la fonction
Edge.

### 2.1 URI de redirection OAuth

À coller dans **Facebook Login for Business → Paramètres → Paramètres OAuth du client → URI de
redirection OAuth valides** :

```
https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback
```

Une seule URI, à l'octet près : pas de slash final, pas de paramètre. Toute variante produit
`URL Blocked: This redirect failed because the redirect URI is not whitelisted`.

### 2.2 URL de webhook

À coller dans **Webhooks → Modifier l'abonnement** pour chacun des objets abonnés :

```
https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-webhook
```

**Verify Token** : c'est *vous* qui le choisissez (une chaîne aléatoire longue, par exemple 40
caractères). Il se saisit à deux endroits **identiques** :

1. dans la console Meta, champ *Verify Token* de l'abonnement webhook ;
2. dans Supabase, secret Edge `META_WEBHOOK_VERIFY_TOKEN`.

Générez-le par exemple avec `openssl rand -hex 24`, puis collez-le directement aux deux endroits.
Ne le partagez pas.

### 2.3 Retour dans l'application

Après autorisation, Meta renvoie l'utilisateur sur l'écran Intégrations :

```
https://vyora-saas-ugc.netlify.app/app/business?section=integrations&meta=connected&product=facebook
```

Cette URL n'est **pas** à déclarer chez Meta : elle est fabriquée par le serveur après l'échange
du code.

---

## 3. Les quatre `config_id` et leur usage

Chaque produit a sa propre **configuration Facebook Login for Business**, parce que les
permissions et les actifs diffèrent. Les confondre fait échouer l'autorisation avec une erreur de
permission peu lisible.

Chemin : **Facebook Login for Business → Configurations → + Créer une configuration**.

| Produit | Nom de la configuration | Type de jeton | Variation / actifs | Permission clé | Secret Supabase |
| --- | --- | --- | --- | --- | --- |
| **WhatsApp Business** | `VYORA WhatsApp Embedded Signup` | Jeton d'utilisateur de système d'intégration métier | Variation **WhatsApp Embedded Signup**, produit **Cloud API**, actif *Comptes WhatsApp* | `whatsapp_business_management` | `META_WHATSAPP_CONFIG_ID` |
| **Facebook Pages** | `VYORA Facebook Pages` | Jeton d'utilisateur | Variation *Facebook Login for Business*, actif *Pages* | `pages_manage_posts` | `META_FACEBOOK_CONFIG_ID` |
| **Messenger** | `VYORA Messenger` | Jeton d'utilisateur | Variation *Facebook Login for Business*, actif *Pages* | `pages_messaging` | `META_MESSENGER_CONFIG_ID` |
| **Instagram Business** | `VYORA Instagram` | Jeton d'utilisateur | Variation *Facebook Login for Business*, actifs *Pages* + *Comptes Instagram* | `instagram_content_publish` | `META_INSTAGRAM_CONFIG_ID` |

Pour WhatsApp, le plus simple est **Créer à partir d'un modèle → « WhatsApp Embedded Signup
Configuration With 60 Expiration Token »** : le modèle présélectionne les bonnes permissions et le
bon type de jeton.

**Règle importante** : ne sélectionnez **que** les actifs réellement utilisés. Ajouter *Catalogues*,
*Pixels* ou *Comptes publicitaires* fait apparaître des écrans de sélection supplémentaires que vos
clients ne comprendront pas, et fait abandonner le parcours.

**Où lire l'identifiant** : chaque configuration affiche un **ID** (une longue suite de chiffres).
C'est le `config_id`. Il est public par nature (il apparaît dans l'URL de la boîte de dialogue),
mais il change d'environnement : on le stocke en secret, on ne le code pas en dur.

**Ordre recommandé** : commencez par **WhatsApp** et **Facebook Pages** seulement (les deux
produits de votre priorité). Créez les deux configurations, laissez Messenger et Instagram pour
plus tard — les fiches correspondantes afficheront « configuration manquante » sans rien casser.

---

## 4. Permissions à activer

### 4.1 Permissions par produit (à cocher dans chaque configuration)

**WhatsApp Business :**

```
whatsapp_business_management
whatsapp_business_messaging
```

**Facebook Pages :**

```
pages_show_list
pages_read_engagement
pages_manage_posts
pages_manage_metadata
business_management
```

**Messenger (plus tard) :**

```
pages_show_list
pages_manage_metadata
pages_messaging
business_management
```

**Instagram Business (plus tard) — famille « Instagram Graph API », pas « Instagram Login » :**

```
pages_show_list
instagram_basic
instagram_content_publish
instagram_manage_comments
instagram_manage_insights
business_management
```

> ⚠️ **Ne mélangez pas les deux familles Instagram.** Les permissions `instagram_business_*`
> appartiennent au parcours *Instagram Login* (jeton Instagram direct). Le parcours retenu ici est
> *Facebook Login for Business* avec jeton de Page : le compte Instagram est lu via
> `me/accounts?fields=instagram_business_account`. Demander les permissions de l'autre famille
> produit des `permission_denied` que rien dans l'interface ne saurait expliquer.

### 4.2 Accès Standard vs Avancé

| Situation | Accès suffisant |
| --- | --- |
| Vous testez avec **vos propres** Pages / votre numéro WhatsApp, en tant qu'administrateur de l'application | **Standard** — aucun App Review |
| Des clients **extérieurs** connectent leurs Pages / leur WhatsApp | **Avancé** — App Review obligatoire, permission par permission |

Concrètement : **le premier test réel (étape 5) se fait en mode Développement, avec votre compte,
sans App Review**. C'est le chemin le plus court vers une connexion fonctionnelle. L'App Review
vient après, quand la connexion est prouvée.

---

## 5. Les huit secrets côté serveur

**Emplacement unique : Supabase → Project Settings → Edge Functions → Secrets**, ou
`supabase secrets set` avec la CLI. Jamais dans `.env` du dépôt, jamais dans Netlify, jamais dans
une variable `VITE_*` (tout ce qui commence par `VITE_` finit dans le navigateur).

| # | Secret | D'où il vient | Où le coller | Ce qu'il permet | Sensible ? |
| --- | --- | --- | --- | --- | --- |
| 1 | `META_APP_ID` | App settings → Basic → **App ID** | Secrets Supabase | Construit l'URL d'autorisation | Non (public) |
| 2 | `META_APP_SECRET` | App settings → Basic → **App Secret** → *Show* | Secrets Supabase | Échange du code, `debug_token`, signature des webhooks | **OUI — critique** |
| 3 | `META_WEBHOOK_VERIFY_TOKEN` | **Vous l'inventez** (`openssl rand -hex 24`) | Secrets Supabase **et** console Meta | Poignée de main d'abonnement webhook | **OUI** |
| 4 | `META_WHATSAPP_CONFIG_ID` | Configurations → `VYORA WhatsApp Embedded Signup` → ID | Secrets Supabase | Embedded Signup WhatsApp | Non |
| 5 | `META_FACEBOOK_CONFIG_ID` | Configurations → `VYORA Facebook Pages` → ID | Secrets Supabase | Login for Business Pages | Non |
| 6 | `META_MESSENGER_CONFIG_ID` | Configurations → `VYORA Messenger` → ID | Secrets Supabase | Login for Business Messenger | Non |
| 7 | `META_INSTAGRAM_CONFIG_ID` | Configurations → `VYORA Instagram` → ID | Secrets Supabase | Login for Business Instagram | Non |
| 8 | `VYORA_APP_URL` | **Valeur fixe** : `https://vyora-saas-ugc.netlify.app` | Secrets Supabase | URL de retour après autorisation | Non |

**Déjà présents sur le projet** (ne pas recréer) : `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_DB_URL`, `VYORA_ALLOWED_ORIGINS`. Les fonctions Meta en dépendent.

### Vérification après saisie

```bash
npm run meta:readiness
```

Cette sonde est en **lecture seule**. Elle vérifie que les fonctions répondent (et non qu'elles
sont absentes), que le retour OAuth est traité par le handler avec un `state` refusé, et que le
webhook refuse un faux jeton. Elle **ne prouve aucune connexion Meta**.

---

## 6. Démarches de vérification et d'approbation

### 6.1 Vérification d'entreprise (Business Verification)

**Où** : business.facebook.com → Paramètres de l'entreprise → Centre de sécurité →
**Vérification de l'entreprise**.

**Quand** : indispensable **avant** l'App Review et avant le statut Tech Provider. **Pas**
nécessaire pour le premier test avec votre propre compte en mode Développement.

**Pièces** : document officiel d'immatriculation (registre du commerce, avis fiscal…), nom légal
**identique** au portefeuille Business, adresse, téléphone vérifiable. Délai typique : quelques
jours à deux semaines, avec d'éventuels allers-retours.

### 6.2 App Review (accès avancé)

**Où** : App Dashboard → **Révision de l'application** → Demandes de fonctionnalités.

**Quand** : seulement quand des clients **extérieurs** doivent connecter leurs propres Pages /
numéro WhatsApp.

**Par permission** : une justification d'usage et une **vidéo** montrant le parcours réel dans
VYORA (connexion, puis usage concret : publier, lire les messages). Une vidéo générique ou
accélérée est refusée.

**Ordre** : commencez par `pages_show_list` + `pages_read_engagement` + `pages_manage_posts`
(Facebook Pages), puis `whatsapp_business_management` + `whatsapp_business_messaging`.

### 6.3 Statut Tech Provider WhatsApp

**Où** : App Dashboard → **WhatsApp** → *Getting Started* / *Tech Provider*.

**Exigences** : application Meta de type Business, portefeuille Business rattaché, **vérification
d'entreprise** effectuée, **accès avancé** accordé pour `whatsapp_business_management` **et**
`whatsapp_business_messaging`.

**Pourquoi c'est bloquant** : Embedded Signup ne permet d'accueillir des clients que si
l'application a le statut **Tech Provider** (ou Solution Partner) **et** l'accès avancé. En mode
Développement, vous pouvez onboarding **votre propre** WABA (c'est le test de l'étape 5) ; les
clients extérieurs attendent le statut. Limite par défaut du programme : 10 nouveaux clients par
fenêtre glissante de 7 jours.

### 6.4 Passage en mode Live

**Où** : App Dashboard → bascule **Développement / Live**.

**Prérequis** : les trois URL légales renseignées (§1), l'icône, la catégorie, la vérification
d'entreprise, et au moins un accès avancé pour la permission principale utilisée.

**Ne pas basculer en Live avant que le test réel (étape 5) ait réussi en mode Développement.**

---

## 7. Séquence recommandée — deux produits, quatre preuves

L'objectif n'est pas de tout configurer, mais d'obtenir **quatre preuves réelles** :

- [ ] **A1** — Facebook Page connectée depuis VYORA
- [ ] **A2** — publication réelle visible sur cette Page
- [ ] **B1** — WhatsApp Business connecté depuis VYORA
- [ ] **B2** — message WhatsApp envoyé **et** reçu

Séquence :

1. **Facebook d'abord** (le plus court : une Page, une permission, pas de vérification requise).
2. **WhatsApp ensuite** (Embedded Signup, numéro de test, webhook).
3. Messenger et Instagram seulement après.

Détail de chaque étape dans `docs/meta-premier-test-reel.md`.
