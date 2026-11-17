# Rapport de mission — stabilisation et déploiement sécurisé du socle MCP

> Branche `arena/0188834f-saas-ugc` (base `2278ce6` de `develop`).
> Toutes les valeurs ci-dessous proviennent soit de commandes exécutées dans
> ce dépôt, soit de requêtes réelles sur la production
> (`xbuuhfwobrafcbgtdgjx`). **Aucun test Netlify n'a été lancé, aucune Deploy
> Preview, aucun déploiement frontend.**

---

## 1. État Git

Aucune réécriture d'historique, aucun force push, aucune suppression.

| commit | contenu |
|---|---|
| `97d195d` | client MCP sortant (transport Streamable HTTP) |
| `f42d03e` | artefacts `store-import` / `store-connect` régénérés |
| `0d2b0aa` | chargeurs réépinglés sur `f42d03e` |
| `aaf0783` | artefact `vyora-mcp` régénéré (routes OAuth) |
| `d7962db` | migration de republication de l'artefact `vyora-mcp` |
| `d7e21fa` | clarification `vyora-oauth` |

`HEAD = d7e21fa` = `origin/arena/0188834f-saas-ugc`. Arbre de travail propre.
Ordre des migrations respecté (`20261120090000` → `…090100` → `…090200` →
`20261121090000` → `…091000` → `…092000` → `…093000` → `20261120090200` →
`20261120093500`).

---

## 2. Validations — chiffres exacts

| contrôle | commande | résultat |
|---|---|---|
| suite complète | `npx vitest run` | **2 796 tests / 160 fichiers, 0 échec** |
| typecheck app | `npx tsc -b` | **0 erreur** |
| typecheck edge | `npx tsc -p tsconfig.edge.json --noEmit` | **0 erreur** |
| build production | `npm run build` | **✓ built in 12.15 s** |

La suite complète a été relancée **deux fois** : avant le déploiement, puis sur
l'état final. Identique : 2 796 / 2 796.

Les six échecs rencontrés plus tôt dans la mission avaient été corrigés ; la
cause (dérive des artefacts `store-import`/`store-connect` due aux retouches de
`safe-egress.ts`/`pinned-fetch.ts`) a été prouvée par reconstruction depuis
`c4fc7ee` et figée par `tests/pinned-post-non-regression.test.ts` (7 tests).

---

## 3. `vyora-oauth` — clarifiée avant toute modification

Détail complet : `docs/ai/2026-11-14-vyora-oauth-clarification.md`.

- Fonction **active, version 1**, jamais redéployée, `verify_jwt:false`.
- C'est un **chargeur d'artefact en base** (`SHA256 4a3f6206…`, `CHARS 18868`).
  Les 4 tranches servies se décompressent exactement vers ces 18 868
  caractères : l'artefact en production est intègre.
- Son rôle réel : **gestion des connecteurs OAuth tiers (Google)** via
  `?action=start|callback|list|revoke|refresh|check|audit`. Ce n'est **pas** un
  serveur d'autorisation MCP.
- Aucun partage avec `vyora-mcp` : tables `oauth_*` contre `mcp_*`, RPC
  distincts, secrets distincts. Seules communes : la table d'artefacts (une
  ligne par nom) et `auth.users`.
- L'émetteur OAuth du serveur MCP est **`…/vyora-mcp`**, pas `…/vyora-oauth`.
- **Décision : non redéployée, secrets et jetons intacts.**

---

## 4. Le bundle déployé correspond au code validé

Vérification sur le fichier `supabase/functions/vyora-mcp.edge.js` de `aaf0783` :

- 42 996 caractères, sha256 `7e19ee1aa145ff44057bd1bb305b5eae8803d37700572f546eaf3af51414d8a3` ;
- les 10 tranches de la migration se décompressent **exactement** vers ce
  fichier (comparaison caractère par caractère, pas seulement par empreinte) ;
- aucun `import`/`export` (compatible `new Function`) ;
- `Deno.serve` présent ; aucune fuite (`eyJhbGciOi`, `sb_secret_`,
  `postgres://`, littéral ≥ 40 caractères) ; `SUPABASE_SERVICE_ROLE_KEY`
  n'apparaît que comme **nom** dans le lecteur d'environnement.

Marqueurs réellement présents : `/oauth/authorize`, `/oauth/token`,
`/oauth/register`, `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `resource_metadata`,
`login_required`, `code_challenge`, `invalid_client`, `invalid_grant`,
`unsupported_grant_type`, `registration_endpoint`, `csrf`, `mcp_account_info`,
`X-Frame-Options`, `Content-Security-Policy`.

**Écart avec la production avant déploiement** : la v5 (`82876a4`, 19 857
caractères) ne contenait **aucune** des 16 marqueurs OAuth ci-dessus — elle
exposait seulement `mcp_account_info`. L'écart était donc réel et mesuré.

---

## 5. Déploiement — `vyora-mcp` uniquement

### Version déployée

| champ | avant | après |
|---|---|---|
| version | 5 | **6** |
| id | `76ab5536-cddb-4b75-91d4-908285a134b7` | inchangé |
| `verify_jwt` | `false` | `false` |
| `status` | ACTIVE | ACTIVE |
| `updated_at` | `1794942386530` | `1794946008615` |

### Mécanisme

Deux étapes, chacune vérifiée :

1. **Publication de l'artefact** (transaction `DO` unique, avec sauvegarde et
   contrôles bloquants). L'artefact v5 a d'abord été copié sous
   `vyora-mcp-rollback-20261114`, puis les 10 tranches ont été publiées sous
   `vyora-mcp`. Le bloc échoue sans rien publier si le nombre de tranches,
   la longueur ou l'empreinte md5 diffèrent.
   - Source des tranches : fichier **commité** `d7962db`, récupéré par la base
     elle-même (`pg_net`, HTTP 200, 21 678 octets) puis extrait par SQL —
     donc aucune ressaisie manuelle de base64.
2. **Mise à jour du corps** du chargeur vers `SHA256 7e19ee1a…` /
   `CHARS 42996`, via `update_edge_function` (un champ `body`, `verify_jwt:false`).

### État de la table d'artefacts (relevé après déploiement)

| nom | tranches | caractères | md5 | état |
|---|---|---|---|---|
| `vyora-mcp` | 10 | 18 708 | `973eab43…` | **nouveau** |
| `vyora-mcp-rollback-20261114` | 5 | 8 888 | `ec86f41c…` | sauvegarde |
| `vyora-ai` | 9 | 16 120 | `065344ce…` | **inchangé** |
| `vyora-ai-providers` | 9 | 16 128 | `a9554b73…` | **inchangé** |
| `vyora-oauth` | 4 | 7 764 | `58b0ca4c…` | **inchangé** |
| `vyora-provider-health` | 2 | 3 968 | `c40c3932…` | **inchangé** |

### Incident contrôlé pendant la bascule

Entre la publication de l'artefact et la mise à jour du chargeur, la v5 a
refusé le nouvel artefact : `503 EDGE_ARTIFACT_UNAVAILABLE`
(`artifact_size_mismatch:42996`). C'est le **fail-closed attendu** — aucun code
non vérifié n'a été exécuté. Fenêtre de quelques secondes, refermée par le
déploiement du chargeur v6. Ordre choisi sciemment : le contraire aurait exposé
une erreur de vérification d'empreinte.

---

## 6. Vrais tests HTTP — après déploiement

> Méthode : appels réels vers `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp…`
> via `pg_net` (pas `curl` : le sandbox n'a pas d'accès sortant vers Supabase).
> Chaque réponse est lue dans `net._http_response` (statut, en-têtes, corps).
> **Ce sont de vrais échanges réseau, pas des simulations.**

| # | point | requête | résultat observé |
|---|---|---|---|
| 1 | `initialize` | POST + jeton réel | **200**, `protocolVersion 2025-06-18`, `serverInfo vyora-mcp 2.0.0`, `capabilities.tools` |
| 2 | `tools/list` | POST + jeton réel | **200**, **11 outils**, écriture absente |
| 3 | `vyora_account_info` | user A | **200**, `user_id 373436db…`, plan Découverte, `available_units 5`, source `saas_ugc.ugc_wallets` |
| 4 | métadonnées ressource | GET `/.well-known/oauth-protected-resource` | **200**, `resource` + `authorization_servers` = `…/vyora-mcp` |
| 5 | métadonnées autorisation | GET `/.well-known/oauth-authorization-server` | **200**, `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` |
| 6 | RFC 7591 | POST `/oauth/register` | **201**, `client_id` émis, `client_secret:null`, `scope:"read"`, `Cache-Control: no-store` |
| 7 | enregistrement sans URI | POST `/oauth/register` | **400** `invalid_redirect_uri` |
| 8 | consentement — PKCE exigé | GET `/oauth/authorize` sans `code_challenge` | **400**, « Le paramètre code_challenge PKCE est requis (43 à 128 caractères) » |
| 9 | consentement — resource exigé | GET `/oauth/authorize` sans `resource` | **400**, « Le paramètre resource (RFC 8707) est requis » |
| 10 | consentement — refus sans session | GET `/oauth/authorize` complet, sans cookie | **401**, « Connectez-vous à VYORA avant d'autoriser un client MCP », `X-Frame-Options: DENY`, CSP `default-src 'none'; sandbox` |
| 11 | échange de code | POST `/oauth/token` code inconnu | **400** `invalid_grant`, `no-store` |
| 12 | refresh | POST `/oauth/token` refresh inconnu | **400** `invalid_grant`, `no-store` |
| 13 | grant non supporté | POST `/oauth/token` `client_credentials` | **400** `unsupported_grant_type` |
| 14 | jeton invalide / révoqué | POST sans jeton, puis jeton révoqué | **401** `-32001` ; après révocation **401** également |
| 15 | isolation 2 utilisateurs | `vyora_account_info` avec jeton B | **200**, `user_id b7e561f9…`, `available_units 0` — jamais les données de A |

Contrôles complémentaires :

- **Défi RFC 9728** sur le 401 : `WWW-Authenticate: Bearer realm="vyora-mcp",
  error="invalid_request", resource_metadata="…/.well-known/oauth-protected-resource"`.
- **Écriture refusée** : `vyora_product_create` → `-32602`,
  « l'écriture est désactivée sur ce déploiement » ; `mcp_activity_log` :
  `outcome=invalid`, `error_code=write_disabled` ; `saas_ugc.ugc_products`
  reste à **0 ligne**.
- **Outil inconnu** : `-32602`, « Outil inconnu », liste des 11 outils autorisés.
- **Aucun secret** : les 15 réponses réelles sont exemptes de `sb_secret_`,
  `sbp_`, `service_role`, `postgres://`, `eyJhbGciOi`, `SUPABASE_SERVICE_ROLE_KEY`,
  `GOOGLE_CLIENT_SECRET`, `VYORA_OAUTH_ENCRYPTION_KEY` et de tout jeton ≥ 40
  caractères.
- **Isolation prouvée** : les deux réponses portent des `user_id` distincts et
  des soldes distincts (5 contre 0) ; aucune donnée croisée.

### Ce qui reste simulé (et pourquoi)

Les deux points suivants ne peuvent pas être exercés en réel sans navigateur :

- **consentement explicite accordé** (POST `/oauth/authorize`) : exige un
  cookie de session Supabase valide ;
- **échange de code réussi → jetons émis, puis refresh réussi** : exige un code
  d'autorisation émis par le parcours navigateur ci-dessus.

Ces deux parcours sont couverts par **35 + 21 + 25 tests unitaires**
(`mcp-oauth`, `mcp-oauth-routes`, `mcp-oauth-consentement`) contre les
générateurs de requêtes réels, mais **n'ont pas été validés en production**.
Les tests 11 et 12 ci-dessus prouvent le chemin d'erreur, pas le chemin nominal.

---

## 7. Sécurité préservée

| exigence | état |
|---|---|
| isolation stricte entre utilisateurs | **vérifiée en réel** (test 15) |
| aucun accès inter-tenant | aucune route ne prend d'identifiant utilisateur en entrée |
| aucun secret dans les réponses ou les logs | **vérifié sur 15 réponses réelles** |
| aucune fonction sensible sans authentification | POST sans jeton → 401 ; consentement sans session → 401 |
| aucun droit d'écriture automatique | `write_disabled`, 0 produit créé |
| aucun affaiblissement SSRF | `safe-egress.ts` / `pinned-fetch.ts` inchangés sur le fond, figés par `pinned-post-non-regression.test.ts` (7 tests) |
| aucun suivi automatique d'une redirection POST | refus de tout 3xx sur POST (test dédié) |
| aucun changement destructif | aucune table, colonne, fonction ni ligne métier supprimée |

---

## 8. Fichiers et données de test — nettoyage

Deux jetons de test ont été émis (`sonde-http-A-20261114`,
`sonde-http-B-20261114`, durée 1 h) pour exercer les tests 1–3, 14 et 15, puis
supprimés avec leurs connexions et rafraîchissements. Le client RFC 7591 de
sonde est marqué révoqué (la ligne est conservée : elle documente l'appel).

État final identique à l'état initial :

| objet | avant | après |
|---|---|---|
| `mcp_tokens` | 1 | **1** |
| `mcp_connections` | 3 | **3** |
| `mcp_oauth_refresh` | 0 | **0** |
| `mcp_oauth_clients` actifs | 0 | **0** |

Aucune donnée métier créée. `saas_ugc.ugc_products` = 0 ligne.
`public.oauth_accounts` = 0 ligne (inchangé).

---

## 9. Problèmes restants

1. **Chemin nominal OAuth non exercé en production.** Le consentement accordé
   et l'émission réelle de jetons via `/oauth/token` demandent une session
   navigateur Supabase. Ils sont couverts par 81 tests unitaires mais restent
   **non prouvés en réel**. C'est le principal écart de cette livraison.
2. **`store-import` (v18) et `store-connect` (v9) exécutent encore les bundles
   de `c4fc7ee`.** Leurs chargeurs au dépôt pointent désormais `f42d03e` : un
   redéploiement serait sûr, mais il **n'a pas été demandé** et n'a donc pas
   été fait.
3. **Deux canaux de chargement coexistent** (artefact en base pour
   `vyora-mcp`, `vyora-oauth`, `vyora-ai*`, `vyora-provider-health` ; bundle
   GitHub épinglé pour `store-import`, `store-connect`). Divergence de
   conception, pas un défaut : à harmoniser seulement sur décision explicite.
4. **La migration `20261120093500` est appliquée en base mais son enregistrement
   d'historique n'est pas garanti** : les tranches ont été publiées par un bloc
   `DO` transactionnel équivalent (mêmes contrôles, même empreinte). Le fichier
   de migration existe au dépôt pour la traçabilité.
5. **La sauvegarde `vyora-mcp-rollback-20261114` reste en base** (5 tranches,
   8 888 caractères). Elle permet un retour arrière immédiat ; à supprimer
   seulement quand la v6 aura été observée en production.

---

## 10. Retour arrière (si nécessaire)

1. Republier sous `vyora-mcp` les 5 tranches de `vyora-mcp-rollback-20261114`
   (md5 `ec86f41c3303501f3f63ee7c39ebc6ea`, 8 888 caractères).
2. Redéployer le corps du chargeur de `82876a4`
   (`SHA256 6e54e12b…`, `CHARS 19857`).

Les deux étapes sont indépendantes du dépôt et ne touchent aucune autre
fonction. **Non exécuté** : la v6 est saine.

---

## 11. Preuves

| nature | où |
|---|---|
| suite de tests | `npx vitest run` → 2 796 / 2 796 |
| typechecks | `npx tsc -b`, `npx tsc -p tsconfig.edge.json --noEmit` |
| build | `npm run build` → ✓ 12.15 s |
| artefact ↔ bundle | 10 tranches → 42 996 caractères, sha256 `7e19ee1a…`, comparaison exacte |
| version déployée | `get_edge_function vyora-mcp` → `version: 6`, `verify_jwt: false` |
| tests HTTP | `net._http_response` ids **13390–13416** (statuts, en-têtes et corps cités ci-dessus) |
| isolation | réponses 13408 (`373436db…`, 5 crédits) et 13409 (`b7e561f9…`, 0 crédit) |
| écriture bloquée | `mcp_activity_log` `write_disabled` ; `ugc_products` = 0 |
| `vyora-oauth` | `docs/ai/2026-11-14-vyora-oauth-clarification.md` |
