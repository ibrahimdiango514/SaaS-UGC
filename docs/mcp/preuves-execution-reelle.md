# VYORA MCP — preuves d'exécution réelle

Toutes les preuves ci-dessous proviennent d'appels HTTP **réels** à la fonction
déployée, exécutés le **2026-11-16** depuis la base (extension `pg_net`), et des
réponses enregistrées dans `net._http_response`. Aucune valeur n'est simulée.

- Fonction : `vyora-mcp`, version **1**, `ACTIVE`, `verify_jwt: false`
- URL : `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp`
- Projet : `xbuuhfwobrafcbgtdgjx`

---

## 1. `initialize` — négociation de protocole

Requête : `POST` avec `Authorization: Bearer vyora_mcp_verifA_…`,
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",…}}`

Réponse **HTTP 200** :

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2025-06-18",
  "capabilities":{"tools":{"listChanged":false}},
  "serverInfo":{"name":"vyora-mcp","version":"1.0.0"},
  "instructions":"Serveur VYORA MCP. Les outils ne donnent acces qu aux ressources de l utilisateur proprietaire du jeton. Les outils d ecriture sont desactives par defaut."}}
```

## 2. `tools/list` — cinq outils, tous en lecture seule

Réponse **HTTP 200** ; chaque outil porte `readOnlyHint: true` et un
`inputSchema` fermé (`additionalProperties: false`) :

| Outil | Rôle |
| --- | --- |
| `vyora_account_info` | identité du compte, espaces de travail |
| `vyora_projects_list` | projets vidéo de l'utilisateur |
| `vyora_generations_list` | tâches de génération |
| `vyora_history_list` | historique d'usage |
| `vyora_integrations_list` | état des connecteurs (sans jeton OAuth) |

L'outil d'écriture `vyora_project_create` **n'est pas annoncé** : il n'est pas
« refusé », il est absent du registre tant que `VYORA_MCP_WRITE_ENABLED` ne vaut
pas exactement `true`.

## 3. Jeton invalide — 401, sans distinction du motif

`Authorization: Bearer vyora_mcp_jeton_totalement_invente` → **HTTP 401** :

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Jeton MCP invalide."}}
```

Le message est identique pour un jeton inconnu, révoqué ou expiré
(`mcp_resolve_token` renvoie zéro ligne dans les trois cas).

## 4. ISOLATION MULTI-UTILISATEUR — le test décisif

Deux utilisateurs distincts, deux jetons distincts, deux projets distincts en
base. Même requête (`vyora_projects_list`), seul le jeton change :

| Jeton | HTTP | `total` | `items[0].title` | `items[0].id` |
| --- | --- | --- | --- | --- |
| utilisateur A | 200 | 1 | **PROJET SECRET A** | `1b29fc61-4b74-499a-a64e-57dca8d4ecee` |
| utilisateur B | 200 | 1 | **PROJET SECRET B** | `72b0a0cf-1049-464a-b13b-9034cbd86891` |

Aucun des deux appels ne contient la moindre donnée de l'autre compte :
l'identité utilisée par la RPC est celle du jeton porteur.

## 5. Tentative d'injection d'identité — rejetée

Le client A envoie `arguments: {"user_id": "0c055bc0…"}` (identifiant de B) :

```json
{"jsonrpc":"2.0","id":20,"error":{"code":-32602,
 "message":"Argument non supporte : user_id","data":{"reason":"unknown_argument"}}}
```

Aucune RPC n'est appelée : le schéma de l'outil est fermé et tout argument
inconnu est refusé. `p_user_id` ne peut provenir que du jeton.

## 6. Outil d'écriture — indisponible par défaut

`tools/call` sur `vyora_project_create` → **HTTP 200**, erreur JSON-RPC :

```json
{"jsonrpc":"2.0","id":21,"error":{"code":-32602,
 "message":"Outil inconnu ou non active : vyora_project_create"}}
```

## 7. `vyora_account_info` — l'identité renvoyée est bien celle du jeton

```json
{"user_id":"7b56a2fb-5982-44db-8500-71698007d1ed",
 "workspaces":[{"role":"owner","workspace_id":"11111111-1111-4111-8111-111111111111", …}]}
```

## 8. `vyora_integrations_list` — état seul, aucun secret

```json
{"items":[]}
```

La RPC a été corrigée après vérification en base : la table réelle est
**`saas_business.integration_connections`** (colonne `connector_key`), et non
`public.integration_connections`. Ni `credential_ref` ni un jeton OAuth ne
sortent de la fonction.

## 9. Journal d'activité — écrit par la fonction elle-même

Contenu de `public.mcp_activity_log` après la campagne :

| méthode | outil | verdict | code | n |
| --- | --- | --- | --- | --- |
| `initialize` | — | ok | — | 1 |
| `tools/list` | — | ok | — | 1 |
| `tools/call` | `vyora_projects_list` | ok | — | 3 |
| `tools/call` | `vyora_account_info` | ok | — | 1 |
| `tools/call` | `vyora_integrations_list` | ok | — | 1 |
| `tools/call` | `vyora_projects_list` | invalid | `unknown_argument` | 1 |
| `tools/call` | `vyora_project_create` | invalid | `unknown_tool` | 1 |

Aucun jeton en clair n'y figure : seulement le préfixe public
(`vyora_mcp_vA111111`).

## 10. Trace d'usage des jetons

| libellé | préfixe | `use_count` | `last_used_at` renseigné |
| --- | --- | --- | --- |
| verif-A | `vyora_mcp_vA111111` | 7 | oui |
| verif-B | `vyora_mcp_vB222222` | 1 | oui |

## 11. Privilèges en base (vérifiés par `has_table_privilege` / `has_function_privilege`)

| Contrôle | Résultat |
| --- | --- |
| `anon` peut lire `public.mcp_tokens` | **faux** |
| `authenticated` peut lire `public.mcp_tokens` | **faux** |
| `anon` peut appeler `mcp_resolve_token` | **faux** |
| `authenticated` peut appeler `mcp_projects_list` | **faux** |
| `service_role` peut appeler `mcp_resolve_token` | **vrai** |
| RLS active sur les 4 tables MCP | **oui** |

## 12. Hachage des jetons

`public.mcp_token_hash('abc')` = `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`,
soit exactement le SHA-256 de `abc` (64 caractères hexadécimaux). La valeur en
clair n'est jamais stockée : `mcp_tokens.token_sha256` ne contient que
l'empreinte, et `mcp_tokens.token_prefix` les 8 premiers caractères publics.

---

## 13. Nettoyage de la campagne

Les jetons de vérification (`verif-A`, `verif-B`, `test-A`) ont été **révoqués**,
puis supprimés avec les connexions, le journal et les données de test :

| Contrôle final | Valeur |
| --- | --- |
| `mcp_resolve_token` sur l'ancien jeton A | 0 ligne |
| `mcp_resolve_token` sur l'ancien jeton B | 0 ligne |
| Jetons MCP restants | 0 |
| Connexions MCP restantes | 0 |
| Lignes de journal restantes | 0 |

Aucune donnée de démonstration ne subsiste : la section MCP du dashboard
s'affichera à l'état vide tant qu'un utilisateur n'aura pas créé son jeton.

## Ce que ces preuves ne couvrent pas

- **Aucun client MCP tiers** (Claude Desktop, Cursor, VS Code) n'a encore été
  connecté : les preuves portent sur le protocole lui-même, pas sur un client.
- **Les outils d'écriture** n'ont pas été exécutés en production : ils sont
  désactivés par conception. `mcp_project_create` a été validée en base
  directement, pas à travers le serveur.
- **Aucun fournisseur tiers** (Gmail, Drive, Instagram…) n'est connecté :
  `vyora_integrations_list` renvoie un état vide, ce qui est la vérité.
