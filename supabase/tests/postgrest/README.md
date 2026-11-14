# Banc d'intégration PostgREST — VYORA (100 % local)

Banc d'intégration qui exécute **le vrai code du dépôt** (les 40 migrations
Supabase + le vrai Edge Function `business-grow`) contre un **PostgreSQL 17
réel** et un **gateway implémentant le contrat de sécurité PostgREST v12.2.3**
(JWT → rôle → `SET LOCAL ROLE` → RLS), sans aucun service distant.

> **Pourquoi un gateway Node et pas le binaire PostgREST ?** Le binaire n'est
> pas distribuable dans ce bac à sable (apt bloqué, assets GitHub non
> joignables). Le gateway (`gateway.mjs`) reproduit le contrat vérifié ligne à
> ligne sur la source officielle PostgREST **v12.2.3**
> (`src/PostgREST/{Auth,Error,Query}.hs`, `docs/references/auth.rst`) :
> vérification HS256 (skew 30 s, audience stricte, claim `role` avec fallback
> `anon`), impersonation `authenticator` + `SET LOCAL ROLE`, mapping
> SQLSTATE → code HTTP (42501→403/401, P0001→400, 23503/23505→409, 42883→404,
> 08xx→503…), réponses d'erreur JSON `{code,message,details,hint}`,
> `WWW-Authenticate: Bearer error="invalid_token"` sur les 401/403 JWT,
> filtres REST `?col.op=valeur` + combinators `or`/`not`,
> PGRST102 (PATCH/DELETE sans WHERE refusés).

## Architecture

| Composant | Port | Rôle |
| --- | --- | --- |
| PostgreSQL 17 (embedded, binaire réel) | 54330 | socle Supabase + 40 migrations du dépôt + seed |
| Gateway PostgREST-conforme | 54331 | `/rest/v1/*` + stub `/auth/v1/user` (contrôle serveur de l'utilisateur) |
| Fournisseurs IA locaux (Groq + Gemini) | 54332 | mêmes contrats d'API (tête `x-goog-api-key`, `supportedGenerationMethods`…), réponses marquées `[mock-groq]` / `[mock-gemini]` |
| **Edge Function `business-grow` (code réel)** | 54333 | `supabase/functions/business-grow/index.ts` compilé (esbuild) et exécuté sur Node avec shim `Deno`, pilote `postgres`→node-postgres (`pg-shim.mjs`), `fetch` des fournisseurs IA redirigé vers 54332 |

Comptes : `postgres`/`supabase_admin`/`authenticator` = `pw`, `bg_edge` =
`bg-edge-bench-pw`, `bg_billing_worker` = `bg-billing-bench-pw` ; clé anon =
`bench-anon` ; clé JWT **générée aléatoirement à chaque exécution** (aucun
secret de production). Données : `/tmp/vyora-postgrest` (jetable).

## Exécution

Prérequis : Node ≥ 22.6 (aucune autre dépendance système).

```bash
cd supabase/tests/postgrest
npm install          # embedded-postgres, pg, esbuild
npm test             # = node run.mjs : base neuve → 40 migrations → seed → 5 suites → arrêt propre
npm run audit        # seul l'audit des fonctions (matrice EXECUTE × rôles)
```

Tests manuels sur l'environnement au repos (deux terminaux) :

```bash
npm start            # monte l'environnement et attend (état dans .state.json : ports, users, clé JWT de banc)
npm stop             # l'arrête proprement
```

`VYORA_KEEP=1 npm test` laisse PostgreSQL démarré (port 54330) après la fin,
pour inspection.

## Suites (`npm test`) — 116 vérifications

| # | Suite | Contenu |
| --- | --- | --- |
| 01 | Parcours JWT (23) | signature, clé étrangère, expiration, `iat` futur, audience stricte, `role` manquant→`anon`, `exp`/`iat` non numériques, 401 avec `WWW-Authenticate`, claims → `auth.uid()`/`auth.jwt()` et RLS par claim |
| 02 | Isolation multi-entreprise (33) | lecture/écriture croisées A↔B (INSERT → **403 « new row violates row-level security policy »**, PATCH/DELETE croisés → 0 ligne touchée), claim `company` falsifié sans effet (identité = `sub`), utilisateur sans entreprise (0 donnée), personnel isolé (subscriptions, usage, notifications), orpheline (workspace sans membre), RPC `reelora_save_scenes` (légitime/croisée), `reelora_start_generation` protégée (quote de pricing requise), quotas par utilisateur, droits admin distincts |
| 03 | Révocation & anti-falsification (18) | valide / expiré (401) / **révoqué** (token toujours signé → 0 ligne en cascade, limite documentée ; `/auth/v1/user` → 401 immédiat = le chemin Edge est révoqué d'emblée) / banni (`/auth/v1/user` → 403) ; transfert d'entreprise (RLS dynamique, même token) ; anti-falsification : `created_by` envoyé par le client → 403 ; connexion directe `bg_edge` (aucun DML direct, `request.jwt.claims` vide) ; `bg_get_workspace_context` refuse le couple illégitime ; frontière de confiance : l'identité RLS est portée UNIQUEMENT par `request.jwt.claims` (sans claims 0 ligne, avec les claims 1 ligne) |
| 04 | Intégration Edge — business-grow réel (31) | auth Edge via `GET /auth/v1/user` (sub inexistant → 401, expiré → 401), `providers.verify` groq+gemini, conversations (isolation A/B), `messages.send` → **l'appel IA traverse le vrai code Edge** (réponse `[mock-groq]`), historique persisté + trace du fournisseur, **idempotence** (2ᵉ envoi même clé → `created=false`, pas de double comptage), quotas (399→398, domaine `business_grow`, **portefeuille Studio UGC intact**), 402 `BG_INSUFFICIENT_QUOTA` sans wallet, rôle coûteux = 2 unités, mémoire (consentement, profil, items, isolation), routing (préférence manuelle respectée), `requests.list`, repli groq→gemini, outils, séparation Studio UGC |
| 05 | Audit des fonctions (11) | matrice EXECUTE complète (JSON + Markdown dans `results/`) + invariants : `saas_business.*` sans aucun EXECUTE client ; partition sans trou ni doublon (edge / billing_worker / erasure / helpers internes / triggers) ; `vyora_payment_*` → `service_role` seul ; `vyora_admin_*` jamais `anon` ; `reelora_*` → `authenticated` (exception documentée : sonde de bootstrap 1er admin) ; `saas_business` 100 % SECURITY DEFINER + search_path figée |

Résultats persistés : `results/results.{json,md}` (chaque vérification avec
son détail) et `results/audit-functions.{md,json}` (matrice complète).

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `run.mjs` | orchestrateur : env + 5 suites + résultats persistés |
| `env.mjs` | `setupEnv()` (PG 17 + socle + 40 migrations + seed) / `startServices()` (gateway + IA + Edge) |
| `pg.mjs` | PG embarqué : démarrage, socle Supabase (rôles, `auth.users`, `auth.uid()/jwt()`, stubs `net`/`cron`/`vault`), application des migrations, vues `public.reelora_*` + grants |
| `base-extra.sql` | tables de base `saas_ugc` (absentes du dépôt, le socle étant additif) + helpers de banc |
| `gateway.mjs` | gateway PostgREST v12.2.3-conforme + stub `/auth/v1/user` |
| `jwt.mjs` | émetteur JWT HS256 (clé aléatoire par exécution) |
| `mock-ai.mjs` | fournisseurs Groq/Gemini locaux (contrats d'API réels) |
| `seed.mjs` | 2 entreprises + 5 utilisateurs + wallets/projets/quotas |
| `test-01-jwt.mjs` … `test-04-edge.mjs`, `audit-functions.mjs` | suites |
| `harness.mjs` | harnais commun (appels REST + compteurs) |
| `build-edge-bundle.mjs` / `edge-runner.mjs` / `pg-shim.mjs` | compilation du **vrai** `business-grow/index.ts` (esbuild) + exécution sur Node (shim `Deno`, `npm:postgres`→node-postgres, `fetch`→IA locales) |
| `start.mjs` / `stop.mjs` | environnement au repos pour tests manuels (état `.state.json`) |
| `smoke-edge.mjs` | smoke test Edge minimal |

## Limites du banc (documentées, assumées)

- **Le gateway est une réimplémentation Node du contrat PostgREST v12.2.3**,
  pas le binaire lui-même (indisponible dans ce bac à sable). Le contrat a
  été vérifié sur la source v12.2.3 ; les comportements spécifiques du
  binaire non retestés ici : pagination `Range`, `Prefer: return=minimal`
  complet, streaming CSV, `Accept: application/vnd.pgrst.object+json`.
- **Révocation des access tokens** : PostgREST ne vérifie que
  signature + expiration — un token révoqué côté auth reste valable sur le
  REST jusqu'à son `exp` (0 donnée en cascade, car les lignes disparaissent).
  Le chemin Edge, lui, passe par `/auth/v1/user` et est révoqué
  **immédiatement**. C'est la limite de conception Supabase, mesurée ici, pas
  un défaut du banc.
- Stubs de `net.*`, `cron.*`, `vault.*` (l'IA et les clés ne quittent jamais
  la machine) ; `embedded-postgres` 17.5.0-beta.15.
- `service_role` est BYPASSRLS : le banc l'utilise uniquement en tant que
  « clé jamais exposée au client » (contrôle orpheline), conformément au
  contrat Supabase.
