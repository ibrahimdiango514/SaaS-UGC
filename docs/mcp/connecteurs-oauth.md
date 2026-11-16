# VYORA — connecteurs OAuth (phase 3)

Ce document décrit l'**architecture** des connecteurs OAuth. La règle du projet
s'applique sans exception : on ne simule aucune connexion et on ne déclare aucun
fournisseur opérationnel sans preuve d'un appel réussi.

## État réel au 14 novembre 2026

| Élément | État |
|---|---|
| Socle OAuth (état CSRF, PKCE, chiffrement AES-256-GCM) | **implémenté, déployé, testé** |
| Tables `oauth_accounts` / `oauth_states` / `oauth_audit_log` | **en production** |
| Edge Function `vyora-oauth` | **v1 ACTIVE** |
| Clé `VYORA_OAUTH_ENCRYPTION_KEY` | **créée et vérifiée** |
| **Identifiants Google** | **absents** |
| Comptes Google réellement connectés | **aucun** |

Le socle commun aux trois fournisseurs Google est donc en place et prouvé en
production (401 sur requête non authentifiée, 400 `state_invalid` sur état
inconnu, 503 `google_not_configured` sur `start` faute d'identifiants).
**Aucun compte Google n'est connecté**, parce que `GOOGLE_CLIENT_ID` et
`GOOGLE_CLIENT_SECRET` n'existent pas encore : ils ne peuvent être créés que par
le propriétaire du projet dans Google Cloud Console.

Voir `supabase/functions/vyora-oauth/DEPLOYED.md` pour la procédure exacte, les
preuves d'exécution et ce qui reste non testé. Le reste de ce document décrit
l'architecture cible, y compris pour les cinq fournisseurs non Google qui
restent bloqués par leurs propres autorisations.

## Principe commun

Chaque connecteur s'appuie sur l'**API officielle** du fournisseur, jamais sur
du scraping ni sur un contournement. Le cycle de vie est identique pour tous :

1. **Autorisation** — l'utilisateur est redirigé vers le fournisseur. VYORA
   fournit `client_id`, `redirect_uri`, `state` (aléatoire, à durée de vie
   courte) et `code_challenge` (PKCE). Le `state` protège du CSRF, PKCE de
   l'interception du code.
2. **Échange** — le code est échangé côté serveur uniquement, dans une Edge
   Function. Le `client_secret` ne quitte jamais le serveur.
3. **Stockage** — les jetons (`access_token`, `refresh_token`, expiration,
   scopes réellement accordés) sont stockés **chiffrés**, dans une table dédiée,
   avec un `credential_ref` opaque. La table `saas_business.integration_connections`
   ne conserve que la référence et l'état : elle est déjà en place et
   `mcp_integrations_list` n'en lit que `connector_key`, `status`, `created_at`.
4. **Rafraîchissement** — une tâche planifiée rafraîchit les jetons expirant
   avant échéance. Un échec de rafraîchissement passe l'état à `expired`, jamais
   à `connected`.
5. **Révocation** — la déconnexion appelle l'endpoint de révocation du
   fournisseur **puis** supprime le jeton chiffré. L'ordre importe : supprimer
   d'abord laisserait un jeton vivant chez le fournisseur.

## Ce qui n'est jamais exposé

| Interdit | Raison |
| --- | --- |
| `access_token` / `refresh_token` vers le navigateur | vol de session par XSS |
| `client_secret` dans le dépôt, le frontend ou un log | fuite irréversible |
| jeton OAuth renvoyé par un outil MCP | un agent ne doit jamais republier |
| jeton OAuth dans l'URL de retour | fuite par Referer et journaux |

`vyora_integrations_list` respecte déjà cette règle : elle ne renvoie que
`connector`, `status`, `connected_at`.

## Fournisseurs prévus et blocages connus

| Fournisseur | API officielle | Autorisation | Blocage actuel |
| --- | --- | --- | --- |
| **Gmail** | Google Workspace / Gmail API | OAuth 2.0 + écran de consentement Google | vérification Google requise pour les scopes sensibles (`gmail.readonly`, `gmail.send`) — **non obtenue** |
| **Google Drive** | Drive API v3 | OAuth 2.0 | même écran de consentement ; scopes restreints (`drive.file` recommandé plutôt que `drive`) |
| **Google Calendar** | Calendar API v3 | OAuth 2.0 | scope sensible (`calendar`) ; vérification Google requise |
| **Instagram** | Instagram Graph API | OAuth via Meta | compte professionnel + application Meta approuvée ; révision d'app exigée pour la publication |
| **TikTok** | TikTok Content Posting API | OAuth 2.0 | éligibilité de l'application et audit de publication — **non obtenus** |
| **Facebook** | Facebook Graph API | OAuth via Meta | révision d'app + permissions de page ; `pages_manage_posts` non accordée par défaut |
| **YouTube** | YouTube Data API v3 + Upload | OAuth Google | quota d'upload (6 vidéos/jour par défaut) + audit Google pour l'upload public |
| **WhatsApp Business** | WhatsApp Cloud API | jeton système Meta Business | compte Business vérifié + numéro dédié ; modèle de message à faire approuver |

**Aucun de ces huit fournisseurs n'est connecté.** Les statuts ci-dessus sont
des prérequis documentés, pas des autorisations obtenues.

## Déclencheurs : ce qui active un connecteur

Un connecteur ne passe à `active` que si **les quatre** conditions sont réunies :

1. les variables d'environnement propres au fournisseur sont présentes
   (vérifiées **par nom**, jamais affichées ni recopiées) ;
2. l'Edge Function de callback est déployée et répond ;
3. un appel de vérification réel (`GET /me`, `/channels`, `/users/@me`… selon le
   fournisseur) renvoie 200 avec un identifiant de compte ;
4. la preuve est enregistrée dans `docs/mcp/preuves-connecteurs.md`.

Tant qu'une condition manque, le connecteur reste **inactif** dans l'interface,
affiché comme tel, sans bouton « Connecter » trompeur.

## État dans l'interface

`src/integrations/contracts.ts` porte déjà `rollout: 'planned'` pour chaque
intégration, et la page VYORA MCP présente l'état réel renvoyé par
`vyora_integrations_list` (aujourd'hui : liste vide). Aucun bouton n'ouvre de
flux OAuth inexistant.

## Ce qui reste à développer

### Fait (socle Google)

- ~~Table des jetons chiffrés, `service_role` seul, clé en secret Supabase.~~
  Réalisé : `oauth_accounts` avec IV et étiquette **par jeton**.
- ~~Edge Function `vyora-oauth` : `start`, `callback`.~~ Réalisé, plus `list`,
  `revoke`, `refresh`, `check` et `audit`.
- ~~Garde de capacités à l'usage (`read|draft|send|modify`).~~ Réalisé et testé.
- ~~Révocation qui efface réellement les cryptogrammes.~~ Réalisé.

### Reste à faire, dans l'ordre

1. **Identifiants Google** (blocage externe) : créer le client OAuth, renseigner
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, déclarer l'URI de redirection.
2. **Premier essai réel** : connecter un compte Gmail en capacité `read` seule,
   vérifier que `callback` enregistre le compte et que les jetons sont bien
   chiffrés en base.
3. **Rafraîchissement planifié** : le code existe (`refresh`), mais aucune tâche
   périodique ne l'appelle encore. À brancher sur `pg_cron`.
4. **Outils MCP de lecture** (`vyora_gmail_search`, `vyora_drive_list`,
   `vyora_calendar_list`) : ils doivent appeler `check` avant toute requête,
   rester en lecture seule au départ, et ne jamais republier un jeton.
5. **Interface VYORA Connect** : connecter / gérer / révoquer, en affichant les
   capacités réellement accordées et jamais un état supposé.
6. **Drive et Calendar** : le socle est déjà commun (mêmes tables, mêmes RPC,
   `provider` déjà contraint). Il ne reste que les appels métier et les tests
   réels de chaque API.
7. **Cinq fournisseurs non Google** : toujours bloqués par leurs autorisations
   propres (révision Meta, éligibilité TikTok, audit YouTube, compte WhatsApp
   Business vérifié).
