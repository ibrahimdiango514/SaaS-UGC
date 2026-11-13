# Business Grow en production — cause, correctif et preuves (2026-11-12)

Projet Supabase : `xbuuhfwobrafcbgtdgjx` — fonction Edge `business-grow`
(`6e29e1f3-a9e1-4258-a399-460ed2576d07`), **version 13**, `ACTIVE`, `verify_jwt: true`.

## 1. Symptômes

| Symptôme écran | Message source | Cause réelle |
| --- | --- | --- |
| « Backend Business Grow indisponible » | `src/business/BusinessGrowWorkspace.tsx` (bandeau backend) | La fonction renvoyait **503 `BOOT_ERROR`** : le déploiement en base était tronqué à ~20 000 caractères. |
| « Le service IA est indisponible » | `BusinessGrowWorkspace.tsx` l. 265 | Correcteur : plus aucun fournisseur routable (`NO_VERIFIED_PROVIDER`, 503) ou requête refusée par CORS (403). |

Après le correctif de démarrage, il restait **deux causes distinctes**, toutes deux
corrigées à la racine :

1. **CORS** — depuis le domaine de production `https://vyora-ugc.netlify.app`, la fonction
   répondait `403 ORIGIN_NOT_ALLOWED`. Le secret `BUSINESS_GROW_ALLOWED_ORIGINS`
   **remplaçait** la liste par défaut ; sa valeur ne contenait pas la production.
   Le navigateur ne recevait donc aucun en-tête `access-control-allow-origin`, et
   `src/business/api.ts` traduisait l'échec réseau en `BUSINESS_GROW_UNAVAILABLE`.
2. **Surveillance planifiée** — le job `pg_cron` `vyora-provider-health-fresh-guard`
   (id 9) et `vyora-provider-health-daily` (id 7) échouaient :
   `ERROR 42725: function public.vyora_provider_health_dispatch() is not unique`.
   La base contenait **deux surcharges** de `vyora_provider_health_dispatch`
   (avec et sans `p_force boolean`), donc l'appel sans argument des jobs était ambigu.
   Conséquence : plus aucune nouvelle vérification de santé au-delà de 24 h, donc
   `bg_select_route` aurait refusé **tous** les fournisseurs → rechute en
   `NO_VERIFIED_PROVIDER` (« IA indisponible ») dans les 24 h.

## 2. Correctifs appliqués

### 2.1 CORS (`supabase/functions/business-grow/index.ts`, non commité)

```ts
const productionOrigins = ['https://vyora-ugc.netlify.app', 'https://*.e2b.app'];

const allowedOrigins = [
  ...defaultAllowedOrigins.split(','),
  ...productionOrigins,
  ...(env('BUSINESS_GROW_ALLOWED_ORIGINS') || '').split(','),
]
  .map((o) => o.trim())
  .filter(Boolean)
  .filter((o, i, all) => all.indexOf(o) === i);
```

Le secret **s'ajoute** désormais à la liste au lieu de la remplacer. CORS n'est pas une
frontière d'authentification : chaque requête exige toujours un JWT VYORA valide (401 sinon).

Secret `BUSINESS_GROW_ALLOWED_ORIGINS` repassé à une valeur **superset** explicite
(localhost 5173/4173, `vyora-ugc`, `saas-ugc-growth`, deploy-preview, `sbc-ai-agency-dashbord`,
`reelora`, `*.netlify.app`, `*.e2b.app`) — aucune clé d'API fournisseur touchée.

### 2.2 Ambiguïté `vyora_provider_health_dispatch` (migration à appliquer)

Nouvelle migration `supabase/migrations/20261112001000_vyora_provider_health_dispatch_ambiguity.sql` :

* suppression de la surcharge `vyora_provider_health_dispatch()` (sans argument) ;
* conservation de la version canonique `vyora_provider_health_dispatch(p_force boolean default false)` ;
* jobs 7 et 9 réécrits en appel explicite `public.vyora_provider_health_dispatch(false)`.

La migration d'origine `20261111234500_vyora_provider_health_cron.sql` est également
corrigée (appel explicite `dispatch(false)` dans les deux `cron.schedule`) pour qu'une
reconstruction depuis zéro ne recrée pas l'ambiguïté.

**Appliquée en production le 2026-11-12 à 00:33 UTC** après autorisation explicite.
Contrôles avant application : `pg_depend` ne renvoyait **aucune dépendance** sur les deux
surcharges, et aucun objet de base n'appelait la version sans argument. Résultat après
application : `select * from pg_proc ... proname='vyora_provider_health_dispatch'` ne renvoie
plus qu'**une seule** signature, `vyora_provider_health_dispatch(p_force boolean)`.

`cron.unschedule` + `cron.schedule` ont recréé les deux jobs avec de **nouveaux identifiants** :
`vyora-provider-health-daily` = **jobid 11**, `vyora-provider-health-fresh-guard` = **jobid 12**
(les anciens 7 et 9 n'existent plus), commande `select public.vyora_provider_health_dispatch(false)`.

### 2.3 Preuve d'exécution cron réelle

Un job de vérification temporaire `zz-verify-dispatch-ambiguity` (jobid 13, `* * * * *`,
même commande) a été créé, observé **puis supprimé** :

```
runid 7115 · jobid 13 · 2026-11-12 00:35:00.134685+00 · succeeded · 55 ms · "1 row"
```

Le **job réel** `vyora-provider-health-fresh-guard` (jobid 12) a ensuite été exécuté une fois
par le planificateur lui-même (cadence temporairement ramenée à `* * * * *`, puis restaurée à
`20 * * * *`) :

```
runid 7123 · jobid 12 · 2026-11-12 00:41:00.082427+00 · succeeded · 22 ms · "1 row"
```

Effet observable du garde-fou : `last_attempts` remis à 0 et `updated_at` avancé à 00:41:00
pour les deux fournisseurs — le job s'exécute et rafraîchit bien son état, sans renvoyer de
contrôle inutile puisque le dernier date de 6 minutes.

Plus aucune erreur `42725`. Cycle complet forcé (`dispatch(true)`) pour sortir du garde-fou
« recent_health_check » sans attendre 45 min :

* `pg_net` **4664** (groq) → **HTTP 200**, `vyora-provider-health`
* `pg_net` **4665** (gemini) → **HTTP 200**, `vyora-provider-health`
* checks écrits : groq `healthy` 164 ms + modèle `openai-gpt-oss-120b` `healthy` ;
  gemini `healthy` 78 ms + modèle `gemini-2.5-flash` `healthy` (2026-11-12 00:36:00 UTC)
* `provider_health_cron_runs` : ids 9/10 `dispatched` → ids 11/12 `healthy`, `http_status 200`

## 3. Preuves HTTP (sondes `pg_net`, aucun appel de génération)

| # | Requête | Résultat |
| --- | --- | --- |
| 4628 | `POST /business-grow`, `Origin: https://vyora-ugc.netlify.app` (avant secret) | 403 `ORIGIN_NOT_ALLOWED` |
| 4631 | idem | 403 `ORIGIN_NOT_ALLOWED` |
| 4629 | `Origin: http://127.0.0.1:4173` (avant secret) | 403 `ORIGIN_NOT_ALLOWED` |
| 4635 | `Origin: https://vyora-ugc.netlify.app` (**après secret**) | **401 `UNAUTHENTICATED`**, `access-control-allow-origin: https://vyora-ugc.netlify.app` |
| 4636 | `Origin: https://evil.example.com` | **403 `ORIGIN_NOT_ALLOWED`** (refus attendu) |
| 4639 | `Origin: http://127.0.0.1:4173` | 401 + allow-origin |
| 4640 | `Origin: https://saas-ugc-growth.netlify.app` | 401 + allow-origin |
| 4641 | `Origin: https://sbc-ai-agency-dashbord.netlify.app` | 401 + allow-origin |
| 4642 | `Origin: https://reelora.netlify.app` | 401 + allow-origin |
| 4643 | Sans `Authorization` | 401 `UNAUTHENTICATED` « Authentification requise. » + allow-origin |
| 4644 | Sans `Origin` | 401 `UNAUTHENTICATED` |
| 4652 | Sans `apikey` (rejet passerelle) | 401 `UNAUTHORIZED_NO_AUTH_HEADER` |
| 4646/4647 | Relais Netlify `/api/business-grow` | 401 propagé, en-têtes du relais sans CORS (même origine, sans impact) |
| 4655 | `Origin: https://vyora-ugc.netlify.app` (re-contrôle final) | **401**, `allow-origin` renvoyé, `vary: Accept-Encoding, Origin` |
| 4656 | `Origin: https://attacker.test` (re-contrôle final) | **403**, pas d'`allow-origin`, `vary: Accept-Encoding` |
| 4670 | `Origin: https://vyora-ugc.netlify.app` (vérification finale post-cron) | **401**, `allow-origin: https://vyora-ugc.netlify.app`, `vary: Accept-Encoding, Origin` |
| 4671 | `Origin: https://evil.example.com` | **403 `ORIGIN_NOT_ALLOWED`**, pas d'`allow-origin` |
| 4672 | `Origin: https://5173-demo.e2b.app` | **401**, `allow-origin: https://5173-demo.e2b.app`, `vary: Accept-Encoding, Origin` |

En-têtes complets 401 (sonde 4643) : `x-served-by: supabase-edge-runtime`,
`sb-request-id`, `x-deno-execution-id`, `vary: Accept-Encoding, Origin`,
`access-control-allow-origin: https://vyora-ugc.netlify.app` — **le nouveau code tourne bien**
(`vary: Origin` n'existe que dans le correctif).

## 4. État réel des fournisseurs IA (lecture seule, sans génération)

`saas_business.bg_list_providers()` exécuté sous le rôle `bg_edge` :

| Fournisseur | Activé | Statut | Config | Vérifié le | Modèle vérifié |
| --- | --- | --- | --- | --- | --- |
| groq | oui | `available` | `configured` | 2026-11-11 23:46:02Z | `openai/gpt-oss-120b` |
| gemini | oui | `available` | `configured` | 2026-11-11 23:46:01Z | `gemini-2.5-flash` |

Les 8 autres fournisseurs (anthropic, deepseek, gonka, kilo, llm7, mistral, openai, openrouter)
sont désactivés / `unverified` : normal, non configurés.

Routage (`ai_routing_rules` × `ai_roles`) : pour les **7 rôles** (`business_analysis`,
`business_advisor`, `action_plan`, `content_strategy`, `marketing_campaign`, `sales_analysis`,
`tool_planning`), **2 routes éligibles** chacune, priorité 1 = `groq / openai-gpt-oss-120b`,
fallback = `gemini / gemini-2.5-flash` — les deux contrôles de santé (fournisseur et modèle)
sont `healthy` de moins de 24 h.

Historique réel de production en base (`ai_requests`) :

```
21:45:43Z  business_advisor  failed                NO_VERIFIED_PROVIDER  (0 tentative)
21:46:41Z  business_advisor  succeeded  groq/openai-gpt-oss-120b  753 ms
21:49:47Z  business_advisor  succeeded  groq/openai-gpt-oss-120b  533 ms
21:50:26Z  business_advisor  succeeded  groq/openai-gpt-oss-120b  639 ms
```

Le `NO_VERIFIED_PROVIDER` de 21:45:43 correspond exactement à la fenêtre où les contrôles
de santé avaient expiré ; les 3 requêtes suivantes, après rafraîchissement, ont abouti du
premier coup sur Groq. Aucune bascule de secours n'a encore été observée en production.

## 5. Ce qui fonctionne / ce qui reste bloqué

**Fonctionne**

* Fonction `business-grow` **v13 ACTIVE**, démarre sans `BOOT_ERROR` (503 disparu).
* CORS : domaine de production, aperçus Netlify, `*.e2b.app`, localhost → acceptés et
  en-tête renvoyé ; origine inconnue → 403.
* Authentification : sans JWT → 401 explicite ; JWT invalide → 401 `UNAUTHENTICATED`.
* Relais Netlify `/api/business-grow` : réponse upstream propagée telle quelle.
* Fournisseurs : Groq **healthy** (164 ms), Gemini **healthy** (78 ms) au dernier cycle
  (2026-11-12 00:36 UTC), routage Groq → Gemini complet sur les **7 rôles** (2 routes éligibles
  chacun, Groq priorité 1, repli Gemini priorité 10).
* Génération réelle : 3 requêtes réussies le 2026-11-11 à 21:46–21:50 UTC.
* `vyora-provider-health-collect` (job 8) : exécutions réussies en continu (toutes les 5 min).
* `vyora-provider-health-daily` (11) et `-fresh-guard` (12) : commande explicite
  `dispatch(false)`, exécution cron réelle vérifiée sans `42725`.

**Reste bloqué**

* **Génération de bout en bout non rejouée** : interdit de consommer un crédit ; validée
  uniquement par l'historique `ai_requests` et les contrôles de santé.
* **Préflight `OPTIONS`** non simulable depuis `pg_net` (le domaine `net.http_method`
  n'accepte que GET/POST/…). Le code répond bien `OPTIONS` avant tout contrôle d'origine
  (`handler.ts`), et `vary: Origin` est présent : preuve indirecte, pas directe.
* **PR #6 non fusionnée** : les correctifs sont commités sur la branche de la PR, pas déployés
  en `main`. Le déploiement Edge v13, lui, est bien actif en production.

---

## Résolution — v15/v16 déployées

### Cause racine n°2 (v15) : `postgres` indisponible pour le bundle

La v15 avait supprimé **tous** les `import` du bundle (contrainte `new Function`),
y compris la réécriture `import postgres from "npm:postgres@3.4.5"` →
`const X = globalThis.__bgPostgres`. Mais le chargeur ne définissait
`globalThis.__bgPostgres` nulle part : la fonction démarrait puis échouait en
`WORKER_ERROR` (HTTP 500) sur chaque requête.

### Correctif (v16)

Le chargeur est un **module ESM valide** pour Deno : il peut importer `postgres`,
et l'injecte **avant** d'exécuter le bundle.

```ts
import postgres from "npm:postgres@3.4.5";
// …
(globalThis as { __bgPostgres?: typeof postgres }).__bgPostgres = postgres;
new Function(CODE)();
```

Le bundle lui-même reste 100 % sans `import` (contrainte de `new Function`).

### Preuves de production (v16, ACTIVE)

| Contrôle | Résultat |
| --- | --- |
| `{"action":"status"}` via la passerelle + JWT utilisateur | **200**, corps applicatif |
| `access-control-allow-origin` | `https://vyora-ugc.netlify.app` |
| `providers.verify` groq | **200**, `healthy`, 451 ms, 11 modèles |
| `providers.verify` gemini | **200**, `healthy`, 642 ms |
| `status` relu | groq + gemini = `available` (persisté) |
| `get_edge_function` | version **16**, `ACTIVE`, `verify_jwt: true` |
| Parité dépôt ↔ prod | payload base64 + SHA-256 `91585eb6…` identiques |

### Garde-fous ajoutés

1. `tests/business-grow-artifact.test.ts` (7 tests) vérifie que l'injection
   `__bgPostgres = postgres` **précède** `new Function(CODE)()`.
2. `tests/studio-preview-coverage.test.ts` (3 tests) interdit au harnais de
   captures de retomber sur un corps générique : toute fonction déclarée dans
   `supabase/config.toml` doit être simulée explicitement, dont `business-grow`.
   C'est ce trou qui avait masqué l'incident.
3. `scripts/studio-preview.mjs` simule désormais `business-grow` (`status`,
   `providers.verify`) et renvoie `UNKNOWN_FUNCTION` pour toute fonction inconnue.

## Rechute v17/v18 et résolution définitive — v19

### Ce qui s'est passé

| Version | Contenu déployé | Résultat |
| --- | --- | --- |
| v16 | `bootstrap.ts` (bundle inline, 17 Ko) | ✅ 200 |
| v17 | corps d'emplacement envoyé par erreur | ❌ fonction cassée |
| v18 | `bootstrap.ts` + motif CORS (17 Ko) | ❌ `WORKER_ERROR` 500 |
| **v19** | **`loader.ts` (3,3 Ko) + bundle lu en base** | ✅ 200 |

Cause racine n°3 : le canal de déploiement ne restitue pas fidèlement un corps
long. Le payload base64 de 16 Ko de la v18 est arrivé altéré ; le garde
d'intégrité du chargeur a refusé de l'exécuter (c'est son rôle), d'où le 500.
La v16 n'avait fonctionné que parce que cette transcription-là était passée.
Un déploiement qui réussit « la plupart du temps » n'est pas un déploiement.

### Correctif : le texte long ne transite plus par le canal de déploiement

- `supabase/functions/business-grow.edge.js` — bundle exact (39 323 car.),
  généré et committé.
- `public._edge_function_artifact` (migration
  `20261112190000_vyora_edge_function_artifact.sql`) — bundles versionnés par
  `(name, sha256)`. La base recalcule l'empreinte (contrainte `CHECK`) : une
  ligne ne peut pas mentir sur son contenu. RLS active, aucun droit pour
  `anon`/`authenticated`, lecture `service_role` seulement.
- `supabase/functions/business-grow/loader.ts` — **seule source déployée**
  (3,3 Ko). Lit la ligne `business-grow` + SHA-256 attendu, vérifie taille et
  empreinte, injecte `postgres`, exécute le bundle. Trois essais à froid ; en
  cas d'échec, répond `503 BUSINESS_GROW_ARTIFACT_UNAVAILABLE` avec le motif et
  des en-têtes CORS, au lieu d'un 500 opaque que l'interface prenait pour un
  backend absent.

Le bundle a été copié **par la base elle-même** (`net.http_get` sur le fichier
épinglé au commit, puis `insert … select`) : aucun intermédiaire ne retranscrit
le code.

### Publier une nouvelle version (procédure)

1. `node scripts/build-business-grow-artifact.mjs`, committer et pousser.
2. Faire récupérer le bundle par la base, au commit poussé :
   ```sql
   select net.http_get(
     url := 'https://raw.githubusercontent.com/ibrahimdiango514/SaaS-UGC/<commit>/supabase/functions/business-grow.edge.js'
   );  -- note l'identifiant renvoyé
   ```
3. Publier la ligne, uniquement si l'empreinte est celle de `loader.ts` :
   ```sql
   insert into public._edge_function_artifact (name, sha256, chars, source, source_ref)
   select 'business-grow',
          encode(extensions.digest(convert_to(content, 'UTF8'), 'sha256'), 'hex'),
          char_length(content), content,
          'ibrahimdiango514/SaaS-UGC@<commit>:supabase/functions/business-grow.edge.js'
   from net._http_response
   where id = <identifiant> and status_code = 200
     and encode(extensions.digest(convert_to(content, 'UTF8'), 'sha256'), 'hex') = '<ARTIFACT_SHA256>';
   ```
   L'ancienne ligne reste en place : la version en service n'est pas touchée.
4. Déployer `loader.ts` tel quel, puis sonder `{"action":"status"}` → 200.
5. Retour arrière : redéployer le `loader.ts` précédent (sa ligne existe encore).

Ne jamais supprimer la ligne dont le SHA-256 figure dans le chargeur en
service : la fonction ne démarrerait plus à froid (503 explicite).

### Preuves de production (v19, ACTIVE, `updated_at` 1794511091637)

| Sonde `pg_net` | Origine | Résultat |
| --- | --- | --- |
| 5843 `status` | `https://vyora-ugc.netlify.app` | 200, `access-control-allow-origin` = origine |
| 5844 `status` | `https://deploy-preview-6--vyora.netlify.app` | 200 (motif d'aperçu ajouté) |
| 5845 `status` | `https://evil.example.com` | 403 `ORIGIN_NOT_ALLOWED` (refus lisible) |
| 5846 `providers.verify` groq | prod | `healthy`, 419 ms |
| 5847 `providers.verify` gemini | prod | `healthy`, 657 ms |
| 5848 `status` | prod | groq + gemini `available` |
| 5849 lecture table, clé publique | — | 401 `permission denied` |
| 5850 lecture table, utilisateur connecté | — | 403 `permission denied` |

Compte sonde `bg-verify@vyora.test` supprimé après les mesures (6 comptes).

### Garde-fous ajoutés

- `tests/business-grow-loader.test.ts` (12 tests) **exécute** le chargeur :
  un seul `Deno.serve`, `postgres` injecté avant le bundle, refus d'un artefact
  absent / tronqué / altéré, reprise au 2ᵉ essai, 503 explicite avec CORS.
- `build-business-grow-artifact.mjs --check` couvre désormais les trois
  fichiers générés (`loader.ts`, `bootstrap.ts`, `business-grow.edge.js`).

### Limites connues

- Démarrage à froid : une lecture PostgREST de 39 Ko en plus. Si la base ou
  PostgREST est indisponible, la fonction répond 503 — mais elle ne pourrait de
  toute façon rien faire sans la base.
- `bootstrap.ts` (variante inline) reste générée pour un canal fiable
  (`supabase functions deploy`) ; ce n'est **pas** ce qui tourne en production.

## Diagnostic complémentaire — aperçu Vite du 13 novembre 2026

L'erreur affichée dans l'aperçu `:5173` associait une exception réseau du
transport direct à deux 404 de relais. Elle ne prouve pas que la fonction de
production est absente ni que la passerelle JWT bloque le préflight.

Contrôles réels avant correctif :

- un préflight `OPTIONS` de l'origine `https://5173-ixvau0x17mxgbrve22xk3.e2b.app`
  vers la fonction active répond **204** avec `Access-Control-Allow-Origin` et
  les en-têtes demandés ;
- un `POST` avec JWT invalide répond **401** avec CORS `*` au niveau de la
  passerelle ; le déploiement conserve donc `verify_jwt=true`, et le handler
  vérifie en plus le jeton avec GoTrue avant toute action métier ;
- les deux relais de `https://vyora-ugc.netlify.app` répondent **401 JSON**
  sans session, donc sont présents. L'aperçu Vite, lui, n'avait pas de relais
  `/api/business-grow` et renvoyait 404.

Correctifs : Vite et `vite preview` disposent maintenant d'un relais
same-origin vers le projet configuré, qui ne transmet ni cookies, ni origine,
ni secret serveur. Les lectures peuvent basculer entre les transports ; avant
une écriture, une lecture vérifie le canal, puis l'écriture n'est **jamais**
rejouée automatiquement après une réponse incertaine. Le statut IA inconnu et
l'historique non chargé ne sont plus présentés comme des résultats vides.
Pour une origine refusée, le préflight réussit seulement la négociation CORS ;
le `POST` reste refusé par un 403 `ORIGIN_NOT_ALLOWED` avant authentification
et accès au stockage, désormais lisible dans le navigateur.

Limites : le relais Vite exige lui-même une sortie réseau vers Supabase. Si
l'appareil **et** le serveur de prévisualisation ne peuvent joindre Supabase,
aucune modification CORS ne peut rétablir la connexion : il faut autoriser le
réseau ou utiliser le site de production avec son relais Netlify. Le frontend
de production doit être publié séparément pour recevoir les changements d'UI
et de transport ; déployer l'Edge Function ne met pas à jour le bundle Netlify.
