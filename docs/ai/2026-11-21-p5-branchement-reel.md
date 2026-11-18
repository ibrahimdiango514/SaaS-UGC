# P5 — branchement réel : ce qui est fait, ce qui est bloqué

Date : 2026-11-21 · Branche : `arena/0188834f-saas-ugc` · Commit : `858dfa3`

## 1. Vérification de la base — la migration n'est PAS appliquée

Contrairement à ce qui a été annoncé, les objets P2 sont absents de la base
cible (`xbuuhfwobrafcbgtdgjx`). Mesures faites le 2026-11-21 :

| Vérification | Résultat |
|---|---|
| `to_regclass('public.mcp_servers')` | `null` |
| `to_regclass('public.mcp_servers_secrets')` | `null` |
| `to_regclass('public.mcp_servers_public')` | `null` |
| Relations nommées `%mcp_server%` (tous schémas) | **0** |
| Fonctions P2 (`mcp_servers_*`, `mcp_is_workspace_member`) | **0** |
| Politiques RLS sur `mcp_servers%` | **0** |
| `supabase_migrations.schema_migrations` contenant `mcp_external` | **0** |

La base est bien la bonne : `current_database() = postgres`, 209 migrations
enregistrées, dernière `20261118140000` (`ugc_import_progress_resume`).

Données existantes, intactes : `ugc_workspaces` 3, `ugc_workspace_members` 3,
`vault.secrets` 3. Les connecteurs boutiques ne sont pas touchés.

**Le DDL via le connecteur est bloqué par le filtre du fournisseur** : un
`create table` de test a été refusé avant réception de l'appel. Je ne l'ai pas
reformulé pour passer outre, conformément à la consigne.

## 2. Ce qui a été implémenté malgré le blocage

### `supabase/functions/mcp-client/accueil.ts` — accès réel

- `lireConnexion` : **un seul** `SELECT` qui filtre `id`, `user_id`, ET
  `mcp_is_workspace_member(user_id, workspace_id)`. Une permission retirée est
  donc vue immédiatement, sans cache à invalider.
- `lireSecret` : passe **exclusivement** par `public.mcp_servers_secret(uuid)`
  (`security definer`, `service_role`). Aucune requête sur
  `vault.decrypted_secrets` : `service_role` n'a pas ce privilège, et ne doit
  pas l'avoir.
- Garde-fou de nom : `lireSecret` refuse tout nom qui n'est pas
  `mcp_server_<uuid>`. On ne peut pas détourner l'appel vers un autre secret
  Vault (`reelora_worker_token` est refusé — testé).

### `supabase/functions/mcp-client/index.ts` — Edge Function

- Identité : **uniquement** `/auth/v1/user` avec le JWT de l'en-tête
  `authorization`. Aucun `x-user-id` n'est lu.
- Corps plafonné à 256 Kio, vérifié sur l'en-tête **et** sur la taille réelle.
- Sortie réseau : `safePost` inchangé. Port 443 imposé, et une panne de
  connexion remonte en `PinnedFetchFailure('connect_failed')` pour ne pas être
  confondue avec une « réponse illisible ».
- Journalisation : identifiants, outil, statut. Jamais d'arguments, jamais de
  secret.

### Aucune écriture, par construction

La migration P2 **ne contient pas** de colonne d'autorisation d'écriture.
`ecrituresAutorisees` est donc renvoyé vide par `accueil.ts`. Conséquence
directe : aucune écriture n'est possible aujourd'hui, quel que soit le corps de
la requête. Ce n'est pas un oubli — c'est la consigne « n'activer aucune
écriture automatiquement », rendue vraie par le schéma lui-même.

Lever cette limite exigera une colonne dédiée **et** une UI d'accord explicite,
pas un ajout silencieux dans la couche d'accès.

## 3. Tests — ce qui est simulé, ce qui est réel

### Réellement exécuté sur Supabase

- Les **vérifications de schéma** du §1 (17 requêtes via le connecteur).
- Rien d'autre : la migration n'étant pas appliquée, aucun test d'isolation
  entre deux utilisateurs réels n'est possible. Il n'est pas prétendu.

### Simulé (14 tests, `tests/mcp-accueil.test.ts`)

Faux client SQL qui reproduit la sémantique des deux requêtes et **échoue
bruyamment sur toute autre**. Ce que cela prouve : le code applique les bons
filtres et traduit les valeurs inattendues en refus. Ce que cela ne prouve
pas : que PostgreSQL les applique — ce sera établi par les tests réels.

### Réel sur banc local (36 tests, lots précédents)

Contre un vrai serveur MCP : sur chaque refus, le compteur `tools/call` du
serveur reste à **zéro**.

## 4. Déploiement

**Non déployé.** Décision assumée : déployer `mcp-client` maintenant
produirait une fonction qui échoue à chaque appel sur
`relation "public.mcp_servers" does not exist`. L'état actuel est fail-closed
et sans effet de bord ; un déploiement prématuré n'ajouterait que du bruit
d'erreurs.

Version en production inchangée : `store-import` v18, `store-connect` v9,
`vyora-mcp` v6. Aucune fonction `mcp-client` n'existe.

## 5. Validations

- `vitest run` : **167 fichiers / 2 889 tests, 0 échec**
- `tsc -b` : 0 erreur
- `tsc -p tsconfig.edge.json --noEmit` : 0 erreur
- `npm run build` : succès (16,64 s)

## 6. Ce qu'il faut pour débloquer

Exécuter `supabase/migrations/20261121100000_mcp_external_connections.sql`
dans le SQL Editor Supabase, puis me le signaler. J'enchaînerai :

1. vérification des 3 relations, 7 fonctions, politiques RLS, index et
   contraintes ;
2. tests réels à deux utilisateurs et deux workspaces ;
3. déploiement de `mcp-client` ;
4. preuve que le secret est illisible depuis le frontend.
