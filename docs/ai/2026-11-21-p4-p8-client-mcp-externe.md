# P4/P8 — client MCP externe : client, permissions, banc d'essai réel

Date : 2026-11-21 · Branche : `arena/0188834f-saas-ugc`

## Ce qui est fait

### 1. Distinction entre refus SSRF et panne réseau

`supabase/functions/mcp-client/client.ts` repliait `blocked_url`, `dns_failed`,
`dns_empty`, `connect_failed` et `tls_failed` sur un unique code `reseau`. Un
hôte privé refusé avant toute connexion était donc présenté comme « serveur
injoignable » : l'utilisateur pouvait croire à une panne passagère et réessayer
indéfiniment une URL qui ne passera jamais.

Nouveau découpage :

| Cause réelle | Code remonté | Sens affiché |
|---|---|---|
| `blocked_url`, `dns_failed`, `dns_empty` | `serveur_invalide` | URL non autorisée |
| `connect_failed`, `tls_failed` | `reseau` | serveur injoignable |
| `timeout` | `timeout` | délai dépassé |
| `too_large` | `trop_gros` | réponse trop volumineuse |

Aucune protection n'est modifiée : c'est un code de retour, pas une règle de
sécurité. L'assertion existante de `tests/mcp-client.test.ts` qui attendait
`reseau` pour `10.0.0.5` a été **renforcée** — elle vérifie désormais
`serveur_invalide`, et surtout que `connect` n'est jamais appelé.

### 2. Banc d'essai contre un VRAI serveur MCP

`tests/mcp-external-live.test.ts` lance un serveur HTTP Node qui parle
JSON-RPC MCP et le joint par la **vraie** sortie épinglée
(`safePost` → `buildRequest` → socket TCP). Aucun mock de transport.

| Exigence P8 | Test | Nature |
|---|---|---|
| Connexion | `initialize` + `tools/list` | **réel** (TCP, HTTP, JSON-RPC) |
| Auth valide | jeton accepté, 3 outils découverts | **réel** |
| Auth invalide | état `auth_required`, aucun outil | **réel** (401 du serveur) |
| Découverte | noms + schémas restitués | **réel** |
| Outil de lecture | `list_products` exécuté, réponse du serveur | **réel** |
| Refus d'écriture non autorisée | `delete_product` → `outil_non_autorise`, **0 appel reçu côté serveur** | **réel** |
| Écriture confirmée | l'appel part réellement | **réel** |
| Expiration de jeton | 401 en cours de session → `authentification` | **réel** |
| Révocation locale | plus aucun appel, serveur muet | **réel** |
| Redirection malveillante | 302 sur POST → refus, jamais suivie | **réel** |
| SSRF | adresse locale refusée **sans** connecteur injecté | **réel** (le refus SSRF s'exécute) |
| Serveur indisponible | `PinnedFetchFailure('connect_failed')` → `reseau` | réel pour le mapping, connexion simulée |
| Timeout | socket muet, abandon à 300 ms → `timeout` | réel pour l'abandon, latence simulée |
| Réponse malformée | `{ ceci n est pas du json` → erreur de protocole | **réel** |
| Aucun secret observable | jeton absent du résultat, y compris son empreinte | **réel** |

**Simulé dans ce banc** : la résolution DNS (le banc écoute sur `127.0.0.1`,
on lui fournit une résolution publique fictive) et TLS (HTTP en clair). Ce
sont les deux seules choses que le banc substitue ; le contrôle SSRF, lui,
tourne pour de vrai et un test dédié prouve qu'il refuse encore quand on ne
lui injecte rien.

### 3. Deux pièges rencontrés, corrigés dans le banc seulement

- Un `connect` qui lève un `Error` générique est classé `protocole` par
  `httpGetPinned` : la couche réelle lève `PinnedFetchFailure`. Le banc utilise
  désormais la vraie classe.
- Un socket factice dont `close()` ne débloque pas la lecture en cours
  n'aboutit jamais : le test de timeout bloquait. Le socket de test libère
  maintenant sa lecture sur `close()`, comme un socket Deno.

Aucun de ces deux points n'a nécessité de toucher au code de production.

## Validations

- `vitest run` complet : **164 fichiers / 2 839 tests, 0 échec**
- `tsc -b` : 0 erreur
- `tsc -p tsconfig.edge.json --noEmit` : 0 erreur
- `mcp-client` + `mcp-external` + `mcp-external-live` : 78/78

## Ce qui reste ouvert

- **La migration P2 n'est pas appliquée** : `create_migration` a été refusé par
  le filtre du connecteur Supabase. Le fichier est dans le dépôt
  (`supabase/migrations/20261121100000_mcp_external_connections.sql`) mais la
  base ne contient pas encore `public.mcp_servers`. Aucune écriture ne peut
  être persistée avant cela.
- P3 (OAuth externe), P5 côté handler, P6 (interface), P8 isolation
  inter-utilisateurs/inter-workspaces **en base** : à faire, et l'isolation ne
  pourra être prouvée qu'une fois la migration appliquée.
