# P6 — Serveurs MCP sortants : rapport de livraison

Date : 2026-11-18 · Branche : `arena/0188834f-saas-ugc` · Projet Supabase : `xbuuhfwobrafcbgtdgjx`

Ce rapport sépare strictement trois choses : ce qui est **simulé** (tests),
ce qui a été **réellement exécuté** en production, et ce qui reste **à faire**.

---

## 1. Ce qui est livré

### Côté serveur (Edge Function `mcp-client`)

Cinq routes de gestion, toutes authentifiées (`verify_jwt: true`) :

| Route | Méthode | Réponse |
|---|---|---|
| `/gestion/lister` | POST | `200 {ok, serveurs[]}` |
| `/gestion/creer` | POST | `201 {ok, serverId, serveur}` |
| `/gestion/tester` | POST | `200 {ok, etat, protocole, outils[]}` |
| `/gestion/permissions` | POST | `200 {ok, toolPermissions}` |
| `/gestion/revoquer` | POST | `200 {ok:true}` |

Le code métier est déployé via un **chargeur épinglé** : l'artefact est lu à un
commit précis du dépôt public, et sa taille + son empreinte SHA-256 sont
vérifiées avant exécution. Un bundle tronqué ou modifié n'est jamais exécuté.

### Côté application

- `src/mcp/serveurs.ts` — client des routes de gestion (fetch direct, jeton
  utilisateur en `Authorization`, `apikey` en en-tête).
- `src/integrations/MesServeursMcpPage.tsx` — écran « Mes serveurs MCP » :
  ajout par URL, mode d'authentification, secret, test de connexion, permissions
  outil par outil, révocation, multi-serveurs.
- Route `/app/mes-serveurs-mcp` + entrée de navigation.

### Décisions de conception tranchées

- Permissions **explicites, outil par outil**. Une première découverte pose tous
  les outils en `pending` : aucun accès n'est accordé implicitement.
- Un **re-test conserve** les choix de l'utilisateur.
- Un outil qui disparaît du serveur voit sa permission **supprimée**.
- **Aucune écriture n'est accordable** par cette API : il n'existe ni paramètre
  ni colonne permettant d'autoriser une action d'écriture.
- `tester` n'émet **jamais** `tools/call` : un test ne déclenche aucune action au
  nom de l'utilisateur, il prouve seulement que la session s'ouvre.

---

## 2. Ce qui a été réellement exécuté en production

Suite de validations sur le vrai projet Supabase, avec un vrai utilisateur, un
vrai jeton, et un vrai serveur MCP distant (**Microsoft Learn MCP Server**,
`https://learn.microsoft.com/api/mcp`).

| Étape | HTTP | Résultat observé |
|---|---|---|
| `creer` | **201** | serveur créé, statut `unknown` |
| `lister` | **200** | ligne réelle renvoyée (url, `authKind none`, `aSecreet false`) |
| `tester` | **200** | `connected`, protocole `2025-06-18`, **3 outils réels** |
| `permissions` (outil connu) | **200** | `microsoft_docs_search: allowed`, les autres `pending` |
| `permissions` (outil inconnu) | **404** | `outil_inconnu` |
| `tester` (après permission) | **200** | permission `allowed` **conservée**, 3 outils |
| `revoquer` | **200** | `{ok:true}`, statut `revoked`, `revoked_at` posé |
| `tester` (après révocation) | **409** | `revoked` |

Les 3 outils réellement découverts, avec leurs descriptions d'origine :

- `microsoft_docs_search`
- `microsoft_code_sample_search`
- `microsoft_docs_fetch`

Persistance vérifiée en base : `status = connected`, `protocol_version =
2025-06-18`, `server_name = Microsoft Learn MCP Server`, `server_version = 1.0.0`,
`tools` = 3 éléments, `last_error` nul, `last_checked_at` à l'instant du test, et
`tool_permissions` contenant exactement les trois outils en `pending` après
découverte — puis `allowed` pour un seul après action explicite.

**Données de test supprimées** : serveur, ligne d'appartenance au workspace et
utilisateur de test. Contrôle final : 0 serveur, 0 membre, 0 utilisateur, 0
secret Vault orphelin.

---

## 3. Le défaut trouvé par ce test réel (et corrigé)

Le premier `tester` réel a renvoyé **500 `erreur_base` — « La base n'a pas pu
traiter la demande »**.

### Ce que ce n'était pas

L'hypothèse initiale — `Deno.resolveDns` absent du runtime Edge — était
**fausse**. `store-import` utilise `Deno.resolveDns` en production depuis
longtemps. Le défaut n'était ni le DNS, ni le réseau, ni le TLS.

### Ce que c'était

Un diagnostic temporaire, protégé par un nonce aléatoire et retiré aussitôt, a
donné la cause exacte :

```
PostgresError: new row for relation "mcp_servers" violates check constraint
"mcp_servers_tools_array"
```

Le pilote sérialise une valeur **selon le type du paramètre**. Avec
`${JSON.stringify(outils)}::jsonb`, la chaîne produite était encodée une seconde
fois : `tools` arrivait en base comme la **chaîne** `"[{...}]"`, et non comme un
tableau. La contrainte `jsonb_typeof(tools) = 'array'` refusait donc l'écriture.
Même mécanisme pour `tool_permissions` (`mcp_servers_permissions_object`).

### Correction

Cast explicite `::text::jsonb` aux trois points d'écriture. Le paramètre est
typé TEXT, la chaîne part telle quelle, PostgreSQL la parse.

Deux tests de non-régression capturent les requêtes réellement construites et
vérifient qu'aucune valeur non nulle n'est liée à un cast `::jsonb` direct. Ces
tests ont été **vérifiés comme échouant sur l'ancien code**, donc ils prouvent
bien le défaut plutôt que de le décrire.

### Défaut secondaire corrigé au passage

`traduireErreurSql` traduisait **toute** exception inconnue en « erreur de
base ». Comme `tester` fait de la base **puis** du réseau, une panne réseau
envoyait l'utilisateur — et le diagnostic — au mauvais endroit. Désormais un
motif réseau donne `502 reseau_indisponible`. Cette correction est un
**gain de diagnostic indépendant** : elle n'était pas la réparation du 500.

---

## 4. Valeur des tests (simulé ≠ réel)

- Suite complète : **171 fichiers, 2999 tests** au vert.
- `tsc -b` : 0 erreur. `tsc -p tsconfig.edge.json` : 0 erreur. `npm run build` : OK.
- Les tests couvrent le contrat HTTP, les validations, les refus de sécurité et
  la sérialisation SQL. **Ils n'ont pas trouvé le défaut du double encodage** —
  c'est le test réel en production qui l'a trouvé. Cette distinction est
  importante : la suite verte ne prouvait pas que `tester` fonctionnait, car
  aucun test n'exerçait un vrai PostgreSQL.

---

## 5. Limites connues

- Un test intermittent (`tests/ai-core-admin.test.tsx`) échoue parfois sous
  charge parallèle et passe systématiquement isolé. Hors périmètre de P6,
  non corrigé ici.
- La découverte n'a été validée en réel que sur **un** serveur MCP
  (Microsoft Learn, sans authentification). Les modes `bearer`, `api_key` et
  `oauth` restent couverts par les tests, pas par un appel réel.
- Il n'existe aucun outil de lecture des logs Edge dans l'outillage disponible ;
  le diagnostic a donc été obtenu par relevé temporaire côté réponse HTTP.

---

## 6. Dette préexistante, hors périmètre

- `_bg_artifact_parts` sans RLS.
- `vyora_files` avec `anon=arwdDxtm`.
