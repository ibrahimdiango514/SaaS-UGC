# P6b — Exécution réelle des outils MCP externes et validation des authentifications

Date : 2026-11-18 · Branche : `arena/0188834f-saas-ugc` · Projet Supabase : `xbuuhfwobrafcbgtdgjx`

Ce rapport sépare **simulé** (tests), **réel** (exécuté en production) et **limites**.

---

## 1. L'objectif, et où il en est

> Un utilisateur VYORA doit pouvoir connecter un serveur MCP externe, autoriser un
> outil, l'exécuter réellement et recevoir ses données dans VYORA, en toute sécurité.

**C'est fait, et prouvé en production** — sur Microsoft Learn MCP, avec de vraies
données renvoyées par le vrai serveur : 21 555 puis 24 063 octets de documentation
réelle selon la requête.

La chaîne est désormais complète : création → test → découverte → autorisation
explicite → exécution → résultat affiché → révocation.

---

## 2. Ce qui a été ajouté

### 2.1 La route qui manquait : `/gestion/executer`

Le module `execution.ts` (P5) contenait déjà la porte d'exécution — relire la base,
vérifier la permission, refuser les écritures — mais **aucun transport HTTP ne
l'exposait**. Aucun outil ne pouvait donc réellement s'exécuter. La route existe
maintenant, avec un validateur dédié (`validerExecution`).

Ordre strict des contrôles, et **aucun octet émis vers l'internet avant qu'ils
aient tous passé** :

1. identité GoTrue ;
2. forme de la demande (serverId, nom d'outil, arguments) ;
3. connexion relue en base **pour cet utilisateur** ;
4. connexion ni révoquée, ni jamais testée (`status = connected`) ;
5. secret lisible côté serveur (jamais transmis au client) ;
6. outil réellement découvert ;
7. permission persistée `allowed` ;
8. classement lecture / écriture.

### 2.2 Un défaut bloquant trouvé en route

`classerOutil` ne reconnaissait un verbe de lecture qu'en **premier mot** du nom.
Les trois outils réellement découverts sur Microsoft Learn — `microsoft_docs_search`,
`microsoft_docs_fetch`, `microsoft_code_sample_search` — étaient donc classés
**écriture**, parce que leur préfixe est le nom du produit. La fonctionnalité
d'exécution aurait refusé les trois outils du seul serveur validé en production.

Correction : un verbe de lecture **n'importe où dans le nom** suffit, un verbe
d'écriture l'emportant toujours (`get_and_delete_order` reste une écriture).

**Durcissement trouvé au passage** : `search_and_destroy` était classé **lecture**
(« destroy » absent de la liste). Verbes destructeurs (`destroy`, `drop`,
`truncate`, `wipe`, `write`, `modify`, `save`, `kill`, `deploy`…) et verbes
français (`supprime`, `modifie`, `envoie`, `crée`…) ajoutés.

### 2.3 Interface

Page « Mes serveurs MCP » : bouton **Exécuter** uniquement sur un outil de
**lecture** ET **autorisé** ; sur une écriture, la mention « écriture · désactivée »
et **aucun bouton**. Modale d'arguments JSON, affichage du résultat réel, erreurs
distinctes.

Le classement `lecture` est calculé **par le serveur** et exposé par `versJson`,
avec la même règle que la porte. Le navigateur ne devine rien : deux règles
dupliquées finiraient par diverger.

---

## 3. Exécuté réellement en production

Deux utilisateurs et deux espaces créés pour l'occasion (supprimés après), sur le
vrai projet Supabase, avec de vrais jetons.

### 3.1 Parcours complet sur Microsoft Learn

| Étape | HTTP | Résultat observé |
|---|---|---|
| `creer` | 201 | connexion créée, statut `unknown` |
| `tester` | 200 | `connected`, `2025-06-18`, **3 outils réels** |
| `executer` (outil `pending`) | **403** | `outil_non_autorise` |
| `permissions` | 200 | `microsoft_docs_search: allowed` |
| `executer` | **200** | **21 555 octets** de données Microsoft Learn réelles |
| `executer` (après v7) | **200** | **24 063 octets**, contenu différent selon la requête |
| `executer` (outil inconnu) | **404** | `outil_inconnu` |

Le contenu renvoyé est du vrai texte Microsoft Learn (« Get started with .NET AI and
the Model Context Protocol », etc.), pas une reconstruction locale.

### 3.2 Les trois authentifications

Aucun serveur MCP public ne fournit d'identifiants temporaires pour les trois modes.
Un **vrai serveur MCP a donc été déployé** comme banc (`mcp-banc-auth`), avec TLS,
JSON-RPC et un jeton distinct par mode — vérifié à temps constant, chaque mode
refusant le jeton d'un autre. Il a été **supprimé après la campagne**.

| Mode | Connexion | Découverte | Exécution réelle | Jeton invalide | Révocation |
|---|---|---|---|---|---|
| `bearer` | 200 `connected` | 2 outils | 200 — `source: banc-auth-bearer` | 409 `auth_required` | 409 `revoked` |
| `api_key` | 200 `connected` | 2 outils | 200 — `source: banc-auth-apikey` | 409 `auth_required` | — |
| `oauth` | 200 `connected` | 2 outils | 200 — `source: banc-auth-oauth` | 409 `auth_required` | 409 `revoked`, secret détruit |

Le champ `source` renvoyé par le banc prouve **quel mode** a réellement été accepté :
le jeton `bearer` ne fonctionne pas sur le point d'entrée `api_key`, et réciproquement.
Un jeton d'un autre mode présenté au mauvais point d'entrée a été refusé (409).

**Secret incorrect à l'exécution** : une connexion maintenue `connected` avec un
jeton devenu invalide a reçu un vrai 401 du serveur distant, traduit en
`authentification` / 401 par VYORA. Couverture dans ce test : l'état de départ a été
**forcé en base** (le scénario « identifiants tournés après un test réussi » n'a pas
de route dédiée) ; l'appel réseau et le refus, eux, sont réels.

### 3.3 Écritures : désactivées, prouvé

`create_item` a été **délibérément autorisé en base** (`allowed`) avant d'être appelé,
pour rendre le test plus fort que nécessaire :

- `executer` sur `create_item` → **403 `ecriture_desactivee`** ;
- le banc aurait répondu `ECRITURE_EFFECTUEE` s'il avait été appelé : il ne l'a pas été.

Un client qui envoie `ecritureAutorisee: true` ou `permission: "allowed"` reçoit
**400 `champ_non_accepte`** — un refus explicite, pas un champ ignoré en silence.

### 3.4 Isolation multi-utilisateur, en production

| Tentative de B | Résultat |
|---|---|
| exécuter un outil sur la connexion de A | **404 `server_not_found`** |
| révoquer la connexion de A | **404 `server_not_found`** |
| `lister` | ne voit que **son** serveur (1, le sien) |
| état de la connexion de A après ces tentatives | **intact** (`connected`, permissions inchangées) |

### 3.5 Erreurs réseau, délais, réponses invalides

- **Délai d'attente réel** : un point d'entrée du banc retenait sa réponse 25 s ;
  VYORA a coupé à son propre délai et répondu **502 « n'a pas répondu dans le délai
  imparti »** (`code: timeout`), sans attendre le serveur.
- **Réponse illisible** et **délai dépassé** sont couverts par les tests d'intégration
  contre un vrai serveur HTTP local (voir §4).

### 3.6 Fuite de secrets

- Aucun des trois jetons n'apparaît dans **aucune réponse HTTP** enregistrée
  (`net._http_response` : 0 occurrence).
- Aucun jeton dans la table `mcp_servers` (0 occurrence).
- Le journal (`journal(...)`) écrit l'utilisateur, la connexion, l'outil et l'issue —
  **jamais** un secret ni les arguments. Vérifié par un test qui envoie un argument
  `motDePasse: hunter2` et cherche sa trace.
- Les réponses d'exécution ont été vérifiées : aucun `Bearer`, aucune valeur d'identifiant.

---

## 4. Ce que les tests couvrent (simulé)

- **3027 tests / 172 fichiers** au vert.
- `tsc -b` : 0 erreur · `tsc -p tsconfig.edge.json` : 0 erreur · `npm run build` : OK.
- 17 tests d'intégration de `/gestion/executer` contre un **vrai serveur MCP local** :
  chaque refus vérifie **zéro octet émis** (compteur de méthodes du serveur de banc),
  pas seulement le code de retour ; isolation sur deux utilisateurs ; délai respecté
  en moins de 2 s ; réponse illisible ; journal sans secret.
- 6 tests d'interface : bouton absent sur une écriture **même autorisée**, absent sur
  `pending`, appel réel avec arguments, erreur affichée sans faux succès, arguments
  non-objet refusés sans appel, aucun jeton à l'écran.

**Une limite de méthode, dite franchement** : la suite verte n'a pas trouvé le défaut
de classement — c'est la confrontation aux vrais outils découverts qui l'a révélé.
Un test écrit contre une hypothèse fausse ne prouve que l'hypothèse.

---

## 5. Limites restantes, à ne pas maquiller

1. **OAuth n'est validé qu'en mode « jeton d'accès stocké ».** Le parcours complet
   (code d'autorisation, point de terminaison de jeton, `refresh_token`, rotation)
   n'est **pas** implémenté côté VYORA. Ce qui est prouvé : un serveur protégé par
   OAuth accepte le jeton fourni, refuse un jeton invalide, et la révocation détruit
   le secret. Ce qui ne l'est pas : l'obtention du jeton par VYORA lui-même.
2. **L'interface n'est pas déployée.** Aucun déploiement Netlify (crédits épuisés) :
   l'écran est validé par tests et build, pas dans un navigateur de production.
3. **Le classement lecture/écriture reste heuristique** (nom + description). Il est
   volontairement pessimiste : `readOnlyHint` du serveur n'est **pas** consulté, car
   un serveur ne décide pas seul que son outil est inoffensif. Conséquence assumée :
   un outil de lecture au nom opaque (`do_thing`) est classé écriture et refusé.
4. **Suppression d'une ligne `mcp_servers` = secret Vault orphelin.** Constaté en
   nettoyant les données de test : 5 secrets sont restés après suppression des lignes
   (supprimés à la main). La révocation, elle, nettoie correctement — c'est le seul
   chemin exposé par l'API. Un futur écran d'administration devra en tenir compte.
5. **Les logs Edge ne sont pas lisibles depuis l'outillage disponible** ; les preuves
   viennent des réponses HTTP et de l'état en base.

---

## 6. Architecture préservée

- **A. VYORA → les IA** : `vyora-mcp` **v6**, inchangée.
- **B. Applications externes → VYORA** : `mcp-client` **v7**, multi-tenant, une seule
  fonction pour tous les utilisateurs — aucune instance par utilisateur.

La porte d'exécution est **la même** pour la route de gestion et pour le transport
MCP : une seule implémentation de la décision, donc aucun risque qu'un chemin
applique une règle plus permissive que l'autre.

Isolation : chaque lecture filtre sur `user_id` **et** l'appartenance au workspace,
avec un filtre écrit explicitement (la vue publique s'appuie sur `auth.uid()`, qui
est nul en `service_role`).

---

## 7. Nettoyage et état final

- Banc d'authentification **supprimé** (`mcp-banc-auth`).
- 2 utilisateurs de test, 2 espaces, 8 connexions et 5 secrets Vault **supprimés**.
- Contrôle final : 0 serveur MCP, 0 secret `mcp_server_*`, 0 utilisateur de test,
  3 espaces (les vrais).
- Fonctions de production non concernées, inchangées : `vyora-mcp` v6,
  `store-import` v18, `store-connect` v9, `vyora-oauth` v1.

Dette préexistante, hors périmètre : `_bg_artifact_parts` sans RLS ; `vyora_files`
avec `anon=arwdDxtm`.
