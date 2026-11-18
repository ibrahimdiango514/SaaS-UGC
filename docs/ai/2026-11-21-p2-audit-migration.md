# P2 — audit de la migration et préparation de l'exécution manuelle

Date : 2026-11-21 · Branche : `arena/0188834f-saas-ugc` · Commit correctif : `e7ca59e`
Base cible : `xbuuhfwobrafcbgtdgjx` · PostgreSQL **17.6**

## 1. Verdict

La migration était **applicable** mais contenait **un défaut réel de privilèges**
et **une affirmation fausse en commentaire**. Les deux sont corrigés.

Elle n'a pas été exécutée : je ne peux pas envoyer de DDL par le connecteur
(filtre du fournisseur, déjà constaté). Le SQL est fourni ci-dessous, prêt à
coller.

## 2. Le défaut de privilèges (corrigé)

Ce projet a un `pg_default_acl` sur `public` qui accorde **`arwdDxtm`** à
`anon`, `authenticated` et `service_role` sur **toute nouvelle table**. Mesuré :

```
postgres     | public | r | {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
postgres     | public | f | {postgres=X, anon=X, authenticated=X, service_role=X}
```

Or la version initiale faisait :

```sql
revoke all on public.mcp_servers from public, anon;   -- authenticated NON nommé
```

`REVOKE ... FROM public` ne retire que les droits accordés à `PUBLIC`
(pseudo-rôle), **pas** ceux accordés nommément à `authenticated`. Sur une
nouvelle table, `anon` et `authenticated` auraient donc conservé
INSERT / UPDATE / DELETE / TRUNCATE / TRIGGER, malgré la RLS et malgré
l'absence de politique d'écriture (les GRANT sont une seconde barrière
indépendante).

Correctif appliqué :

```sql
revoke all on public.mcp_servers from public, anon, authenticated;
grant select on public.mcp_servers to authenticated;
grant select, insert, update, delete on public.mcp_servers to service_role;
```

Idem pour `mcp_servers_secrets` et la vue. `TRUNCATE` et `TRIGGER` ne sont plus
accordés à personne : `TRUNCATE` **contourne la RLS** et détruirait l'historique
des connexions, ce qui contredirait la règle « aucune suppression automatique ».

## 3. L'affirmation fausse en commentaire (corrigée)

Le fichier affirmait, et j'avais moi-même écrit dans un rapport précédent, que
`service_role` n'avait pas accès à `vault.decrypted_secrets`. **C'est faux.**

```
has_table_privilege('service_role','vault.secrets','select')            → true
has_table_privilege('service_role','vault.decrypted_secrets','select')  → true
has_schema_privilege('service_role','vault','usage')                    → true
```

Ce sont des privilèges **par défaut de la plateforme**, antérieurs à ce travail.
Je ne les révoque pas : `store-connect`, `vyora-provider-health` et d'autres
fonctions vivantes lisent Vault par ce chemin, et une révocation casserait la
production. Le commentaire dit maintenant la vérité et en tire la conséquence :
**`service_role` ne doit jamais être exposé à un navigateur**. Toute lecture de
secret reste dans une Edge Function qui l'utilise côté serveur.

## 4. Vérifications réellement exécutées sur Supabase

| Vérification | Résultat |
|---|---|
| Rôles `anon`, `authenticated`, `service_role`, `authenticator` | présents |
| Extensions `pgcrypto` (`extensions`), `supabase_vault` (`vault`) | présentes |
| `public` créable par `anon` / `authenticated` | **non** → `search_path` sûr |
| Collisions de noms (8 contraintes, 8 fonctions, 4 index, 2 politiques) | **0** |
| `vault.create_secret` | 4 args, 3 défauts → appel à 3 args valide |
| `vault.update_secret` | 5 args, 4 défauts → appel à 2 args valide |
| Appartenance : `public.ugc_workspace_member` (col `user_id`, `workspace_id` uuid) | conforme |
| `public.ugc_*` : nature réelle | **vues** `security_invoker=true` |
| Tables réelles `saas_ugc.ugc_workspace_members` | RLS **activée**, 5 politiques |
| `SELECT` réel en rôle `anon` sur `public.ugc_workspace_members` | **REFUSÉ** (`42501`) |
| Migrations enregistrées | 209, dernière `20261118140000` |
| Dernière migration vs `20261121100000` | postérieure → ordre correct |
| Tables / fonctions / politiques P2 existantes | 0 |

### Sur l'alerte `ugc_*` : fausse alerte, et pourquoi

J'ai d'abord vu `anon` avec `arwdDxtm` et RLS désactivée sur
`public.ugc_workspace_members`. Avant de conclure, j'ai vérifié la nature de
l'objet : c'est une **vue** en `security_invoker=true`, qui délègue donc à la
table sous-jacente `saas_ugc.ugc_workspace_members`, laquelle a la RLS active.
Un `SET LOCAL ROLE anon` suivi d'un `SELECT` a été **refusé**: aucune donnée
n'est exposée. Rien à corriger, mais vérifié plutôt que supposé.

## 5. Compatibilité avec les 209 migrations

- Aucun objet P2 n'existe (0 collision sur les 8 noms de contraintes, 8
  fonctions, 4 index, 2 politiques).
- Aucune instruction destructive : `2 create table if not exists`,
  `8 create or replace function`, `1 create policy`, **aucun `DROP TABLE`**,
  aucun `ALTER` sur une table existante.
- Seule écriture de données : `delete from vault.secrets where id = v_secret_id`
  dans `mcp_servers_revoke` — sur le secret **du serveur révoqué uniquement**,
  jamais sur un secret préexistant.
- **Fichier non renommé.** Le timestamp `20261121100000` est postérieur à la
  dernière migration enregistrée : l'ordre est correct.

## 6. Ce qui reste simulé

Les tests `tests/mcp-accueil.test.ts` (14) utilisent un faux client SQL : ils
prouvent que le **code** filtre correctement, pas que PostgreSQL le fait. Les
tests d'isolation à deux utilisateurs réels **n'ont pas été exécutés** et ne
sont pas revendiqués. Ils le seront après application.

## 7. Ordre des opérations restantes

1. Vous exécutez le SQL (§8) dans le SQL Editor.
2. Je vérifie réellement : 2 tables + 1 vue, 8 fonctions, 2 index + 1 index
   unique + 1 vue, 8 contraintes, 1 politique RLS, les GRANT.
3. Tests d'isolation réels : 2 utilisateurs, 2 workspaces, révocation, retrait
   de permission, secret illisible depuis le frontend.
4. Déploiement de `mcp-client` seulement après ces contrôles.
5. Écritures : toujours désactivées.

## 8. SQL à exécuter

Contenu intégral : `supabase/migrations/20261121100000_mcp_external_connections.sql`
(602 lignes). Copier **tout le fichier** dans le SQL Editor, puis Run.

Un bloc d'auto-vérification est fourni **en commentaire** à la fin du fichier :
le décommenter après exécution pour contrôler l'état d'un coup d'œil, chaque
colonne devant renvoyer `true`.

Aucun `BEGIN`/`COMMIT` n'est ajouté : le SQL Editor exécute déjà chaque
soumission en transaction, et un `BEGIN` explicite dans certains clients
provoque une erreur « transaction already in progress ».
