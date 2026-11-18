# P9 — `mcp-client` déployée : branchement réel, tests en production, preuves

Date : 2026-11-21 · Base `xbuuhfwobrafcbgtdgjx` · PostgreSQL 17.6
Branche `arena/0188834f-saas-ugc`

## 1. Verdict

| Élément | État |
|---|---|
| Branchement réel `accueil.ts` → fonctions SQL P2 | **opérationnel en production** |
| Edge Function `mcp-client` | **déployée, v1, `verify_jwt: true`** |
| Écritures | **désactivées**, aucune colonne d'autorisation n'existe |
| Autres fonctions | **inchangées** (voir §7) |
| Données existantes | **inchangées** (voir §8) |

## 2. Deux défauts corrigés AVANT déploiement

### 2.1 La couche HTTP n'avait aucun test

`index.ts` importait `npm:postgres@3.4.5`. Un module qui importe un schéma
d'URL `npm:` n'est **pas chargeable par Vitest** : plafond de corps, CORS,
résolution d'identité, ordre des refus et journal — le chemin critique — étaient
donc entièrement non couverts.

La logique est sortie dans `http.ts` (testé, 21 tests). `index.ts` ne garde plus
que le branchement runtime. Comportement inchangé.

### 2.2 CORS cassé en production

`index.ts` construisait sa liste d'origines uniquement depuis
`VYORA_ALLOWED_ORIGINS`. **Cette variable n'existe pas dans le projet** : la
liste était vide, et `resolveCorsOrigin` renvoyait `access-control-allow-origin:
null` à **toutes** les requêtes. C'est exactement la panne déjà rencontrée sur
`store-connect`.

Correction : passage par `buildAllowedOrigins`, qui part des valeurs par défaut
du dépôt (`src/lib/origin-allowlist.ts`) et n'y ajoute que des suppléments.
Vérifié par 6 tests, dont « variable absente ⇒ origine autorisée ».

### 2.3 Message d'écriture mensonger

`deciderAppel` renvoyait `ecriture_non_confirmee` (« confirmation explicite
requise ») alors qu'il **ne reçoit jamais** la confirmation ponctuelle. Ce code
était donc inatteignable dans son sens littéral, et le message annonçait un
bouton qui n'existe pas : la migration P2 ne porte aucune colonne
d'autorisation d'écriture.

Remplacé par `ecriture_desactivee` — « les écritures ne sont pas activées sur
cette connexion : lecture seule ». La branche `ecriture_non_confirmee` reste
dans `executerOutilExterne`, seul endroit où la confirmation est connue.

## 3. Tests locaux (Vitest) — 168 fichiers, 2 912 tests, 0 échec

Dont `tests/mcp-http.test.ts` (**21 nouveaux**) : CORS, plafonds, refus avant
base, refus avant réseau avec compteur `tools/call` côté serveur.

Typechecks : `tsc -b` **0**, `tsc -p tsconfig.edge.json` **0**.
Build Vite : **OK**. `check:edge-imports` : **OK**.

## 4. Déploiement réel

Mécanisme identique à `store-connect` : chargeur épinglé sur un commit immuable,
taille + empreinte SHA-256 vérifiées avant exécution.

| Élément | Valeur |
|---|---|
| Commit épinglé | `128d2872699e0db03fa67e3ddeb2fdbfa4e3bda5` |
| Bundle | `supabase/functions/_artifacts/mcp-client.js` |
| Taille | **27 402 caractères** |
| SHA-256 | `3924d04c6bf3195412d9afc3d7b16ae05b3bf61b176b96bfac25f885256d54e0` |
| Fonction | `mcp-client` v1, `verify_jwt: true` |
| `ezbr_sha256` | identique à l'empreinte du bundle |

**Contrôles du bundle avant commit** : aucun `import` résiduel, `postgres`
externalisé, aucun JWT, aucune clé, aucune chaîne de connexion, aucun `export`.

**Bundle vérifié à l'URL épinglée** (via `api.github.com`) : 27 402 caractères,
SHA-256 identique. Le chargeur a un second canal (`raw.githubusercontent.com`).

## 5. Tests réellement exécutés en production

Méthode : `pg_net` (vrai HTTP sortant depuis le projet) + `fetch_page`.
Un JWT réel a été obtenu par le flux GoTrue `signup`.

**Discriminant clé** : la connexion de test pointait vers un hôte qui répond
405 à un POST. Donc si un appel réseau partait, la réponse serait `502 http`.
Toute réponse de refus propre prouve qu'**aucun octet n'est sorti**.

| # | Scénario | Code HTTP | Réponse réelle |
|---|---|---|---|
| 1 | OPTIONS / CORS | 200 | origine autorisée renvoyée |
| 2 | POST sans jeton | **401** | `authentification_requise` (couche propre) |
| 3 | Jeton forgé | **401** | `Invalid JWT` — **passerelle GoTrue, avant la fonction** |
| 4 | Corps : UUID invalide | **400** | `server_id_invalide` |
| 5 | Connexion d'un autre utilisateur | **404** | `server_not_found` |
| 6 | Outil jamais découvert | **404** | `outil_inconnu` |
| 7 | Outil non découvert, nom d'écriture | **404** | `outil_inconnu` |
| 8 | Permission retirée | **403** | `outil_non_autorise` |
| 9 | Écriture, sans confirmation | **403** | `ecriture_desactivee` |
| 10 | Écriture **confirmée par le client** | **403** | `ecriture_desactivee` |
| 11 | Connexion révoquée | **409** | `revoked` |
| 12 | Secret effacé de Vault | **409** | `secret_manquant` |
| 13 | Nominal, hôte inexistant | **400** | `serveur_invalide` — « le domaine ne renvoie aucune adresse » |
| 14 | Nominal, `example.com` | **502** | `http` — « le serveur MCP a répondu 405 » |

**Aucun `502` sur les lignes 1 à 12** ⇒ aucun appel réseau sur les refus.

### Ce que prouvent les lignes 13 et 14

Ce sont les preuves décisives que la chaîne complète fonctionne réellement :

- ligne 13 : DNS interrogé et **refusé avant toute connexion** ;
- ligne 14 : DNS résolu, IP publique validée, TLS établi, **POST réellement
  émis**, `example.com` a répondu 405, erreur correctement classée.

Un échec SQL aurait donné 500, pas ces codes. `accueil.ts` a donc bien exécuté
ses requêtes contre PostgreSQL et Vault en production.

### La ligne 10 est la plus importante

Même en envoyant `confirmationEcriture: true` dans le corps, l'écriture est
**refusée**. Le drapeau fourni par le client n'accorde donc rien : seule la base
décide.

## 6. Ce qui reste simulé / non exécuté

- **Aucun serveur MCP distant réel de bout en bout.** L'appel sortant réel a été
  prouvé (ligne 14), mais contre `example.com`, qui n'est pas un serveur MCP :
  la réponse 405 est un rejet, pas une exécution d'outil réussie. Aucun outil
  distant réel n'a été exécuté.
- Les tests `tests/mcp-accueil.test.ts` (14) restent sur faux client SQL.
- Les tests `tests/mcp-execution.test.ts` et `mcp-route.test.ts` utilisent un
  **vrai serveur MCP local**, mais lancé en Node dans les tests, pas en Edge.

## 7. Production préservée — vérifié après déploiement

| Fonction | Avant | Après |
|---|---|---|
| `vyora-mcp` | v6 `76ab5536-…`, `verify_jwt:false` | **identique** |
| `store-import` | v18 `b53d8821-…` | **identique** |
| `store-connect` | v9 `fd99d3ec-…` | **identique** |
| `vyora-oauth` | v1 `30db5365-…` | **identique** |
| `mcp-client` | absente | **v1, nouvelle** |

Aucune autre fonction touchée. Aucun déploiement Netlify, aucun crédit consommé.

## 8. Données existantes — vérifié après nettoyage

| Donnée | Avant | Après |
|---|---|---|
| `auth.users` | 6 | **6** |
| `ugc_workspaces` | 3 | **3** |
| `ugc_workspace_members` | 3 | **3** |
| `saas_ugc.ugc_profiles` | 4 | **4** |
| `saas_immobilier.user_profiles` | 5 | **5** |
| `vault.secrets` | 3 | **3** |
| `mcp_servers` / `_secrets` | 0 | **0** |
| `mcp_tokens` / `mcp_connections` | 1 / 3 | **1 / 3** |

### Comment le compte de test n'a créé aucune donnée

Deux triggers s'exécutent à l'inscription :

- `handle_new_user_profile` crée un profil dans `saas_immobilier` — court-circuité
  si `app_scope` vaut `vyora` ou `vyora_owner` ;
- `ugc_private.on_auth_user_created` crée compte, profil et portefeuille UGC —
  uniquement si `app_scope = 'vyora'`.

Le compte a donc été créé avec `app_scope: 'vyora_owner'` : **aucun** des deux
ne s'est déclenché. Vérifié : +1 utilisateur, +0 workspace, +0 membre, +0 profil.

Une ligne temporaire dans `ugc_workspace_members` a été nécessaire (la fonction
`mcp_is_workspace_member` l'exige) ; elle a été supprimée, ainsi que
l'utilisateur, ses serveurs, ses secrets Vault et ses lignes `pg_net`.

## 9. Reste ouvert

- Tester contre un **vrai serveur MCP distant** (avec un jeton valide) pour
  prouver une exécution d'outil réussie de bout en bout en production.
- `mcp-client` n'est pas encore appelée par l'interface : aucun composant React
  ne l'invoque aujourd'hui.
- Les écritures resteront désactivées tant qu'aucune colonne d'autorisation
  n'existe — conformément à la consigne.
