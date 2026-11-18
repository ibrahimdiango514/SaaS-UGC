# P2 — migration appliquée : vérifications réelles et tests d'isolation

Date : 2026-11-21 · Base : `xbuuhfwobrafcbgtdgjx` · PostgreSQL 17.6
Branche : `arena/0188834f-saas-ugc`

## 0. Contexte

L'exécution dans le SQL Editor a renvoyé une **erreur d'interface React**
(« Failed to execute 'removeChild' on 'Node' »), causée par une extension de
navigateur. Ce n'était **pas** une erreur SQL.

Vérification directe en base : **la migration a bien été appliquée.** Les trois
objets et les huit fonctions existent. Ne jamais conclure sur le message affiché
par un tableau de bord — la base est la seule source fiable.

## 1. Objets créés — vérifiés un par un

| Objet | Attendu | Constaté |
|---|---|---|
| `public.mcp_servers` | table | `relkind='r'`, RLS **activée**, propriétaire `postgres` |
| `public.mcp_servers_secrets` | table | `relkind='r'`, RLS **activée**, **0 politique** |
| `public.mcp_servers_public` | vue | `relkind='v'`, `security_invoker=true` |
| Colonnes `mcp_servers` | 21 | **21** |
| Colonnes `mcp_servers_secrets` | 5 | **5** |
| Colonnes de la vue | 18 | **18** — ni `user_id` ni `secret_ref` |
| Contraintes CHECK | 8 | **8** (auth_kind, status, cohérence, longueur, https, tools, capabilities, permissions) |
| Clés étrangères | 3 | **3** (users ×2, serveurs ×1, toutes `ON DELETE CASCADE`) |
| Index | 4 + clés | `mcp_servers_user_idx`, `mcp_servers_workspace_idx`, `mcp_servers_workspace_name_key` (unique partiel), `mcp_servers_secrets_user_idx` |
| Trigger `mcp_servers_touch` | 1, actif | **1**, `tgenabled='O'` |
| Politique RLS | `mcp_servers_select_own` | **1**, SELECT seul |
| Fonctions | 8 | **8** |

## 2. Privilèges réels (mesurés avec `has_table_privilege`)

| Rôle | `mcp_servers` | `mcp_servers_secrets` | vue |
|---|---|---|---|
| `anon` | **aucun** (S/I/T tous `false`) | **aucun** | **aucun** |
| `authenticated` | `SELECT` **seul** (I/U/D/TRUNCATE `false`) | **aucun** | `SELECT` |
| `service_role` | S/I/U/D | S/I/U/D | `SELECT` |

`authenticated` n'obtient **ni** TRUNCATE **ni** TRIGGER : le correctif du
`pg_default_acl` a bien pris effet.

## 3. Fonctions SECURITY DEFINER

Les 7 fonctions métier sont `prosecdef=true` avec `search_path` verrouillé :

- `mcp_is_workspace_member` → `pg_catalog, public`
- `mcp_servers_create`, `_rotate_secret`, `_revoke`, `_secret` → `pg_catalog, public, vault`
- `mcp_servers_record_probe`, `_set_permissions` → `pg_catalog, public`

`EXECUTE` : **`service_role` uniquement** pour les 8. `authenticated` et `anon`
sont refusés sur toutes.
(`mcp_servers_touch` est un trigger non-DEFINER, `EXECUTE` public sans risque.)

## 4. Tests d'isolation — réellement exécutés sur Supabase

Trois utilisateurs et trois workspaces réels, chacun lié à un seul utilisateur.
Deux connexions de test créées à travers les vraies fonctions.

### Lecture isolée par RLS (rôle `authenticated`, `auth.uid()` réel)

| Test | Résultat |
|---|---|
| A lit `mcp_servers` | **1 ligne** — seulement « Test isolation A » |
| B lit `mcp_servers` | **1 ligne** — seulement « Test isolation B » |
| A demande la connexion de B **par son identifiant** | **0 ligne** |
| A lit la vue `mcp_servers_public` | 1 ligne, `has_secret=true`, aucun secret |
| `anon` lit `mcp_servers` | **refusé** `42501` |

### Écriture refusée

| Test | Résultat |
|---|---|
| `authenticated` INSERT | `permission denied for table` |
| `authenticated` UPDATE (sa propre connexion) | `permission denied` |
| `authenticated` DELETE (sa propre connexion) | `permission denied` |
| `authenticated` SELECT `mcp_servers_secrets` | `permission denied for table` |
| `authenticated` appelle `mcp_servers_secret(uuid)` | `permission denied for function` |
| A crée une connexion dans le workspace de B | `workspace_forbidden` |
| A modifie les permissions de B | `server_not_found` |
| A révoque la connexion de B | `server_not_found` |

### Protection du secret

| Test | Résultat |
|---|---|
| Valeur du secret présente dans `mcp_servers` | **0 occurrence** |
| `mcp_servers_secret(id)` côté `service_role` | **39 caractères, valeur exacte** |
| `mcp_servers_secret(uuid inconnu)` | `null` |
| Secret après révocation | **détruit de Vault**, lecture `null` |

### Révocation

| Vérification | Résultat |
|---|---|
| `status` | `revoked` |
| `revoked_at` | renseigné |
| `secret_ref` | `null` |
| Secret dans `vault.secrets` | **0** (détruit) |
| Ligne conservée (historique) | **1** |
| Pose de permission après révocation | `server_revoked` |

### Retrait de permission

| Vérification | Résultat |
|---|---|
| Pose `{list_products: allowed, delete_product: denied}` | persisté |
| Retrait `{list_products: denied}` | persisté, **l'autre outil préservé** |
| Fusion et non remplacement | confirmé |

> **Note de méthode.** Ma première lecture du retrait semblait montrer un échec
> (`allowed` au lieu de `denied`), parce que la sous-requête de vérification
> lisait la même photographie que l'`UPDATE` dans la même instruction. En
> lecture séparée, la valeur est bien `denied`. C'était un artefact de test, pas
> un bug de la fonction.

### Contraintes

| Test | Résultat |
|---|---|
| URL `http://` | `mcp_servers_url_https` violée |
| `secret` fourni avec `auth_kind='none'` | `secret_not_allowed` |
| Trigger `updated_at` | mis à jour (03:01:14 > 03:00:09 créé) |

## 5. Données existantes — intactes

| Donnée | Avant | Après tests + nettoyage |
|---|---|---|
| `vault.secrets` | 3 | **3** |
| `ugc_workspaces` | 3 | **3** |
| `ugc_workspace_members` | 3 | **3** |
| `mcp_tokens` (MCP entrant) | 1 | **1** |
| `mcp_connections` (MCP entrant) | 3 | **3** |
| `mcp_tool_permissions` | 0 | **0** |
| `mcp_servers` / `_secrets` | — | **0 / 0** (nettoyés) |

## 6. Ce qui reste à faire

- **Aucun appel réseau n'a été testé ici.** Les 36 tests du banc local
  (`mcp-execution`, `mcp-route`) prouvent que le refus précède le réseau avec un
  compteur `tools/call` à zéro, mais **contre un serveur MCP local**, pas depuis
  l'Edge Function déployée.
- `mcp-client` **n'est pas déployé**.
- Les tests `mcp-accueil` (14) restent **simulés** (faux client SQL).
