# Meta Integrations — configuration serveur et console Meta

> État au **2026-11-14**. Ce document décrit **exactement** ce qui est construit, ce qui est
> vérifié, et ce qui reste à faire **par le titulaire du compte Meta**. Il ne prétend nulle part
> qu'une connexion est opérationnelle : une intégration n'est marquée « connectée » qu'après un
> échange OAuth réel, et rien n'est encore marqué ainsi aujourd'hui.

Application Meta : **VYORA**, App ID **1692282959171281**, type **Business**,
mode **Développement**. Domaine public du SaaS : `https://vyora-saas-ugc.netlify.app`.

---

## 1. Les quatre fiches, séparées

| Fiche (catalogue) | Clé | Parcours d'autorisation | Permissions demandées | Webhooks |
| --- | --- | --- | --- | --- |
| WhatsApp Business | `whatsapp` | **Embedded Signup** (SDK JS Meta, `FB.login` + `config_id`, `response_type: 'code'`, `extras.version`) | `whatsapp_business_management`, `whatsapp_business_messaging` | objet `whatsapp_business_account` : `messages`, `message_template_status_update`, `account_update` |
| Facebook (Pages) | `facebook` | **Facebook Login for Business** (redirection `dialog/oauth` + `config_id`) | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_metadata`, `business_management` | objet `page` : `feed` |
| Messenger | `messenger` | **Facebook Login for Business** | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management` | objet `page` : `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads` |
| Instagram Business | `instagram` | **Facebook Login for Business** | `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `business_management` | objet `instagram` : `comments` |

Deux points de conception volontaires :

1. **Aucune fiche ne mélange deux parcours.** WhatsApp n'a pas de variante par redirection : Meta
   impose le SDK. Les trois autres passent par une redirection OAuth serveur, avec `state` à
   usage unique et `redirect_uri` fixe.
2. **Les permissions Instagram sont celles du produit Instagram Graph API « historique »** —
   pas les permissions Instagram Login (`instagram_business_*`). Le parcours OAuth choisi
   (Login for Business, jeton de Page) est cohérent : un compte Instagram professionnel rattaché
   à une Page est lu via `me/accounts?fields=instagram_business_account`. Mélanger les deux
   familles (jeton Instagram Login + jeton de Page) produirait des `permission_denied` que rien
   dans l'interface ne saurait expliquer.

---

## 2. Valeurs exactes à déclarer dans Meta for Developers

Ces valeurs sont **dérivées de l'architecture**, pas inventées : l'URI de redirection est
construite par le code (`callbackUri()`), l'URL de webhook correspond au nom de la fonction Edge.

| Réglage Meta | Valeur exacte |
| --- | --- |
| **Valid OAuth Redirect URIs** (Facebook Login for Business → Settings) | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback` |
| **Allowed domains** (même écran) | `xbuuhfwobrafcbgtdgjx.supabase.co` et `vyora-saas-ugc.netlify.app` |
| **Webhook Callback URL** (Webhooks → `page`, `instagram`, `whatsapp_business_account`) | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-webhook` |
| **Verify Token** (le même dans la console et dans le secret Edge) | contenu de `META_WEBHOOK_VERIFY_TOKEN` — jamais écrit ici |
| **App domains** (App settings → Basic) | `vyora-saas-ugc.netlify.app` |
| **Privacy Policy URL** | `https://vyora-saas-ugc.netlify.app/confidentialite` |
| **Terms of Service URL** | `https://vyora-saas-ugc.netlify.app/conditions` |
| **Data Deletion Instructions URL** | `https://vyora-saas-ugc.netlify.app/confidentialite#suppression-des-donnees` (section « Suppression des données », ancrée : Meta exige une URL qui explique la procédure) |

Toggles à activer (Facebook Login for Business → Settings → Client OAuth settings) :
*Client OAuth login*, *Web OAuth login*, *Enforce HTTPS*, *Embedded Browser OAuth Login*,
*Use Strict Mode for redirect URIs*, **Login with the JavaScript SDK**. Sans *Embedded Browser
OAuth Login* et *Login with the JavaScript SDK*, l'Embedded Signup WhatsApp ne s'ouvre pas : le
SDK ne peut pas rendre le `code` à la fenêtre appelante.

### Configurations Facebook Login for Business à créer

Une par produit, parce que les permissions et les actifs ne sont pas les mêmes :

| Produit | Nom suggéré | Variation | Actifs | Utilisée par |
| --- | --- | --- | --- | --- |
| WhatsApp | `VYORA WhatsApp Embedded Signup` | **WhatsApp Embedded Signup** | WhatsApp accounts | `META_WHATSAPP_CONFIG_ID` |
| Facebook | `VYORA Pages` | **Facebook Login for Business** (variation « Business ») | Pages | `META_FACEBOOK_CONFIG_ID` |
| Messenger | `VYORA Messenger` | idem | Pages | `META_MESSENGER_CONFIG_ID` |
| Instagram | `VYORA Instagram` | idem | Pages + Instagram accounts | `META_INSTAGRAM_CONFIG_ID` |

Le **`config_id`** de chaque configuration se copie depuis **Facebook Login for Business →
Configurations → (configuration) → ID**, et se pose **uniquement** dans le secret Edge
correspondant. Il est public par nature (il figure dans l'URL de la boîte de dialogue), mais on
ne le code pas en dur : il change d'environnement.

Pour WhatsApp, créer la configuration depuis le gabarit **« WhatsApp Embedded Signup
Configuration With 60 Expiration Token »** ou une configuration personnalisée avec la variation
*WhatsApp Embedded Signup*, puis sélectionner le produit **Cloud API**. Sélectionner un actif
non utilisé (Catalogues, Pixels, comptes publicitaires) fait abandonner les clients à l'écran de
sélection : ces actifs ne sont **pas** demandés ici.

---

## 3. Secrets Edge à créer (Supabase → Edge Functions → Secrets)

Aucune valeur ne doit être collée dans un chat, un ticket ou un commit.

| Secret | Rôle | État |
| --- | --- | --- |
| `META_APP_ID` | Identifiant public de l'application | **à créer** |
| `META_APP_SECRET` | Échange de code, `debug_token`, signature des webhooks | **à créer** |
| `META_WEBHOOK_VERIFY_TOKEN` | Vérification d'abonnement webhook (`hub.verify_token`) | **à créer** |
| `META_WHATSAPP_CONFIG_ID` | `config_id` Embedded Signup | **à créer** |
| `META_FACEBOOK_CONFIG_ID` | `config_id` Login for Business Pages | **à créer** |
| `META_MESSENGER_CONFIG_ID` | `config_id` Messenger | **à créer** |
| `META_INSTAGRAM_CONFIG_ID` | `config_id` Instagram | **à créer** |
| `VYORA_APP_URL` | Racine de retour (`https://vyora-saas-ugc.netlify.app`) | **à créer** |

Tant que `META_APP_ID`/`META_APP_SECRET` sont absents, l'action `status` renvoie
`configured: false` et les fiches affichent qu'aucune connexion n'est possible : le bouton
« Connecter » est **désactivé**. Rien ne peut donc échouer silencieusement.

Les jetons Meta obtenus ne vivent **pas** dans des variables d'environnement : ils sont stockés
dans Vault (`vyora_meta_<produit>_<user>_<workspace>`, `vyora_meta_page_…`, PIN WhatsApp dans
`vyora_meta_wa_pin_<user>_<workspace>`), et seules les références (noms) figurent en base.

---

## 4. Fonctionnalités réellement exposées (actions `meta-connect`)

| Action | Ce qu'elle fait réellement |
| --- | --- |
| `start` | Crée un `state` à usage unique en base et rend soit les paramètres Embedded Signup, soit l'URL de dialogue OAuth |
| `finish-embedded` | Échange le `code` **sans** `redirect_uri` (exigence Meta), vérifie `debug_token`, confirme le WABA et le numéro **vus par le jeton**, abonne le WABA aux webhooks, enregistre le numéro (PIN dans Vault), écrit la connexion |
| `status` | Lecture seule de l'état, entreprise par entreprise |
| `verify` | `debug_token` + `me/accounts` : prouve que le jeton fonctionne encore |
| `refresh` | Jeton de Page : échange longévive. Jeton WhatsApp (intégration métier) : **pas de renouvellement possible**, vérification à la place |
| `disconnect` | Supprime la connexion, purge les secrets de Vault, révoque chez Meta (`DELETE me/permissions`) sans bloquer la déconnexion locale si Meta échoue |
| `pages.list` / `pages.select` | Liste `me/accounts` ; une page absente de cette liste est **refusée** (`NOT_OWNED`) ; abonnement webhook par page ; jeton de Page dans Vault |
| `whatsapp.send`, `whatsapp.templates`, `whatsapp.template.create`, `whatsapp.template.delete` | Envoi texte/modèle, gestion des modèles |
| `messenger.send`, `messages.list`, `conversations.list` | Envoi Messenger, historique |
| `facebook.publish`, `facebook.posts`, `facebook.post.delete`, `facebook.insights`, `facebook.comments`, `page.events` | Publication, lecture, suppression, statistiques, commentaires, événements de Page |
| `instagram.account`, `instagram.publish`, `instagram.insights` | Compte professionnel lié, publication, statistiques |

Toutes les actions passent par : JWT utilisateur → abonnement Business Grow actif → droit
d'écriture/lecture sur **cette** entreprise → propriété de la page/connexion. Un jeton ne sort
jamais du serveur ; le navigateur ne reçoit que des états et des URL publiques.

---

## 4 bis. Ce que l'écran permet de faire une fois connecté

Chaque fiche expose les actions du produit, toutes branchées sur Meta — **aucun jeu de
démonstration, aucun compteur local** :

| Fiche | Écran |
| --- | --- |
| Facebook Pages | Publier (texte + lien), lister les publications réelles, lire les commentaires d'une publication, supprimer une publication (avec confirmation), lire les statistiques, lire les événements reçus par webhook |
| Messenger | Boîte de réception (dernier message par contact), fil de conversation, réponse envoyée par `messenger.send` |
| WhatsApp Business | Boîte de réception WhatsApp, modèles approuvés (`whatsapp.templates`) et envoi de modèle (`whatsapp.send`), le tout avec la règle des 24 h rappelée |
| Instagram Business | Compte professionnel relié (`instagram.account`), statistiques (`instagram.insights`), publication d'un média HTTPS (`instagram.publish`) |

Règles d'affichage tenues par les tests : une liste vide affiche « aucun … renvoyé par Meta » ;
un refus du serveur est affiché **tel quel** ; un texte de réponse refusé n'est **pas** effacé ;
le bouton d'envoi d'un modèle reste bloqué tant que le modèle n'est pas `APPROVED` ou que le
destinataire manque ; une page non sélectionnée **désactive** la publication au lieu de la
tenter.

## 5. Webhooks : signature, idempotence, résolution

`meta-webhook` (Edge, `verify_jwt = false`) :

- **GET** : répond au défi `hub.challenge` **uniquement** si `hub.verify_token` correspond à
  `META_WEBHOOK_VERIFY_TOKEN` ; secret absent ⇒ `503` (jamais d'acceptation par défaut).
- **POST** : la signature `X-Hub-Signature-256` (HMAC-SHA256 de `META_APP_SECRET` sur le **corps
  brut**) est vérifiée en temps constant **avant** toute lecture. Secret absent ⇒ `503` ; signature
  fausse ⇒ `401`. Meta reçoit ensuite **toujours** `200` quand la signature est valide — une
  erreur interne ne doit pas provoquer de relivraisons infinies.
- **Anti-doublon** : `meta_webhook_event_record(dedupe_key)` ; une relivraison Meta (même
  `message.id`) ne crée pas de second message.
- **Résolution obligatoire** : un événement dont l'identifiant Meta (numéro, page, compte
  Instagram) n'est rattaché à **aucune** connexion VYORA est ignoré — aucune écriture. Cela évite
  qu'un tiers qui connaîtrait l'URL de webhook injecte des lignes dans une entreprise.

---

## 6. Base de données

Migration `supabase/migrations/20261124100000_meta_integrations.sql`, **appliquée en production**
(projet `xbuuhfwobrafcbgtdgjx`) :

- 6 tables : `meta_connections`, `meta_pages`, `meta_oauth_states`, `meta_webhook_events`,
  `meta_messages`, `meta_page_events`, toutes en `saas_business`, RLS forcée ;
- 21 fonctions `meta_*` : `state_create`/`state_consume`, `connections_list`, `connection_upsert|
  internal|set_status|merge_metadata|delete`, `pages_replace`, `page_internal`,
  `webhook_event_record|finish`, `message_record|set_status`, `messages_list`,
  `conversations_list`, `page_event_record|events_list`, `resolve_phone|page|instagram`.

Recettes exécutées **sur la base réelle** (puis données de test supprimées) :
`state` consommé une fois ⇒ 1 puis 0 ligne ; `connections_list` ne rend la connexion qu'au
propriétaire (autre utilisateur : 0, autre produit : 0) ; `resolve_phone` rend
`{user_id, workspace_id, connection_id}` pour un numéro connu et `null` sinon ; deux
`webhook_event_record` avec la même clé ⇒ 1 seule ligne.

---

## 7. Ce qui reste à faire — et par qui

### Par le titulaire du compte Meta (action humaine, non automatisable)

1. **Vérification d'entreprise** (Business Settings → Sécurité → Vérification de l'entreprise) :
   documents officiels. Exigée avant l'accès avancé aux permissions et avant le statut Tech
   Provider.
2. **Créer les configurations Facebook Login for Business** (§2) et relever les `config_id`.
3. **Poser les 8 secrets Edge** (§3).
4. **Déclarer les URLs** (§2) : OAuth Redirect, Allowed domains, Webhook Callback + Verify Token,
   puis abonner les objets `page`, `instagram`, `whatsapp_business_account`.
5. **App Review** pour l'accès **avancé** des permissions listées §1 — indispensable pour servir
   des clients autres que les administrateurs/développeurs de l'application. Chaque demande exige
   une vidéo du parcours réel et une justification d'usage.
6. **Tech Provider WhatsApp** : Embedded Signup ne peut onboarder des clients qu'avec le statut
   Tech Provider (ou Solution Partner) **et** l'accès avancé à
   `whatsapp_business_management` + `whatsapp_business_messaging`. Limite par défaut : 10 nouveaux
   clients sur 7 jours glissants.
7. **Passage en mode Live** : possible seulement quand *Privacy Policy*, *Terms*, *Data Deletion*
   et l'icône sont renseignés.

### Par l'ingénierie (après les étapes ci-dessus)

1. Poser les secrets, redéployer `meta-connect` (`verify_jwt = false`) et `meta-webhook`, puis
   exécuter un **parcours réel** : WhatsApp Embedded Signup avec un numéro de test, Login for
   Business avec une Page de test.
2. Vérifier en réel : message WhatsApp entrant/sortant, statut de remise, publication de Page,
   commentaire Instagram, et la réception d'un webhook signé.
3. Surveiller l'expiration de version : la version Graph est épinglée dans une seule constante
   (`src/business/meta/products.ts`, `META_GRAPH_VERSION = 'v26.0'`), et un test
   (`tests/meta-products.test.ts`) refuse toute version inférieure à v22.0. À vérifier lors de
   chaque montée de version : la version courante change environ deux fois par an, et **v21.0
   expire le 21 janvier 2027**, v22.0 le 20 mai 2027.

### Réserves explicites (à ne jamais masquer dans une démo)

- `meta-connect` et `meta-webhook` sont **compilés** (`tsc` Edge + contrôle des imports Deno) mais
  **jamais exécutés dans Deno réel** : aucune exécution n'a eu lieu dans l'environnement Edge de
  production.
- **Aucun test Meta réel** n'a été effectué : ni Embedded Signup, ni Login for Business, ni
  webhook signé par Meta. Les tests actuels prouvent le comportement du code contre une API
  simulée et contre la base réelle, **pas** l'interopérabilité avec Meta.
- Les secrets Meta ne sont **pas** posés : `configured: false` est l'état attendu aujourd'hui.
  Aucune intégration n'est donc affichée comme opérationnelle, et aucune ne doit l'être avant
  l'étape 1 ci-dessus.
