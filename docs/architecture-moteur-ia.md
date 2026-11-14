# VYORA — Architecture du moteur IA multi-fournisseurs

> Document d'architecture, vérifié sur le code présent dans ce dépôt (2026-11-14).
> Il décrit **ce qui existe déjà** et **ce qu'il reste à faire** pour accueillir les
> nouveaux fournisseurs, sans réécrire les intégrations en production.
>
> Fiche de renseignement des fournisseurs : [`moteur-ia-fournisseurs.md`](./moteur-ia-fournisseurs.md).
> Dossiers de réception des fournisseurs (documentation seule) : [`fournisseurs-ia/`](./fournisseurs-ia/README.md).

---

## 1. Vue d'ensemble

```
Navigateur (React)
  │  aucun secret, aucun appel direct à un fournisseur
  ▼
Supabase Edge Functions
  ├── vyora-ai            ← moteur central (chat, scripts, hooks, visuels, scènes)
  ├── business-grow       ← espace métier (agent, modules, mémoire)
  ├── reelora-ai / video  ← espace Studio (génération vidéo MuAPI)
  └── _shared/ai-core/    ← cœur partagé : adaptateurs, routeur, moteur, journal
        │
        ├── adapters.ts   gabarits de protocole (aucun fournisseur nommé)
        ├── router.ts     sélection de la chaîne de modèles
        ├── engine.ts     exécution, secours, journalisation des appels
        ├── registry.ts   lecture du registre (fournisseurs, modèles, règles, budget)
        └── types.ts      erreurs, niveaux, credentials
  ▼
PostgreSQL — schéma `saas_business`
  ai_providers · ai_provider_configs · ai_models · ai_roles · ai_routing_rules
  ai_calls_log · ai_memories · budgets · health checks
```

**Principe cardinal :** le registre (base de données) dit *qui a le droit d'être
appelé* ; le code ne contient **aucune** liste de modèles servis en dur. Une clé
présente ne suffit jamais : il faut un fournisseur `available`, une configuration
`configured`, un modèle `verified` et un contrôle de santé de moins de 24 h.

---

## 2. Les fichiers du cœur (`supabase/functions/_shared/ai-core/`)

| Fichier | Rôle | Contraintes tenues |
|---|---|---|
| `types.ts` | `AiProviderAdapter`, `AiProviderError` (codes), `AiLevel`, `AiCredentials` | aucune I/O |
| `adapters.ts` | gabarits de protocole (`openai`, `gemini`, `cloudflare`, `none`) + `resolveAiAdapter(descripteur)` | fonctions **pures**, testables sans réseau |
| `router.ts` | `buildAiChain()` : construit une chaîne ordonnée de modèles pour une tâche | déterministe, plafonnée, anti-double-routage |
| `engine.ts` | `runAiCall()` : exécution HTTP, secours, `fetch` injecté, journalisation | aucune clé écrite hors secrets |
| `registry.ts` | `parseRegistrySnapshot()` : lecture typée du JSON servi par `bg_ai_registry_snapshot()` | tolérant aux champs absents |

### 2.1 Aucune liste de fournisseurs dans le code

Le code ne nomme **aucun** fournisseur : il ne connaît que des **gabarits de
protocole**. Chaque fournisseur est décrit par sa ligne du registre central
(`saas_business.ai_providers`) :

| Colonne | Rôle |
|---|---|
| `provider_key` | identifiant (`^[a-z][a-z0-9_-]{1,39}$`) |
| `display_name` | nom affiché dans les interfaces |
| `adapter_kind` | gabarit : `openai` (chat/completions), `gemini` (natif), `cloudflare` (URL par compte), `none` (protocole dédié, jamais appelé) |
| `default_base_url` | URL de base ; le moteur en déduit `/chat/completions` et `/models` |
| `models_url` | URL de liste des modèles (facultative) |
| `default_headers` | en-têtes supplémentaires (attribution d'agrégateur, version d'API) — **jamais un secret** |
| `api_key_env` | **nom** de la variable portant la clé (la valeur reste un secret Edge) |
| `account_id_env` | **nom** de la variable portant l'identifiant de compte, si le protocole l'exige |
| `is_aggregator` | agrégateur : recours, jamais un doublon de facturation |

**Ajouter un fournisseur** = une ligne de registre (via
`public.vyora_ai_admin_provider_upsert`) + un secret Edge. Aucun fichier de code,
aucune migration, aucun déploiement de code n'est nécessaire. Le fournisseur est
créé `enabled = false` / `unverified` : il n'est servi qu'après une sonde réelle.

### 2.2 Trois gabarits de protocole

1. **`openai`** — un seul constructeur (`resolveAiAdapter`) dérive
   `${base}/chat/completions` et `${base}/models`. Couvre tout fournisseur
   compatible OpenAI, y compris inconnu du code.
2. **`gemini`** — protocole natif : `models/{model}:generateContent`,
   lecture `candidates[0].content.parts`, en-tête `x-goog-api-key`.
3. **`cloudflare`** — conversation au format OpenAI mais URL par compte
   (`accounts/{id}/ai/v1/chat/completions`), donc `accountId` obligatoire.
   La voie d'appel vient du registre (`transport`) : `rest` (jeton Workers AI,
   en-tête `Authorization`) ou `gateway` (passerelle AI Gateway, en-tête
   `cf-aig-authorization` + identifiant de passerelle obligatoire).

Les intégrations historiques (Groq, Gemini, Cloudflare) conservent un adaptateur
dédié qui reproduit **exactement** leur comportement de production ; il est
sélectionné par le registre (`adapter_kind` + `provider_key`), jamais par une
liste écrite dans l'application.

Un gabarit `none` permet de déclarer un fournisseur au registre dont le
protocole n'est pas encore modélisé : il est **listé mais jamais appelé**, et le
moteur journalise `UNSUPPORTED_PROVIDER` au lieu d'envoyer une requête mal formée.

---

## 3. Routage intelligent (`router.ts`)

Ordre d'application des filtres — chacun est éliminatoire :

1. **Règles du rôle** (`ai_routing_rules`) par priorité croissante ; à défaut, le catalogue.
2. **Fournisseur configuré** : une clé Edge existe *et* est chargée.
3. **Modèle vérifié** : sonde API réelle passée (`verification_status = 'verified'`).
4. **Capacités requises** : celles du rôle + celles demandées par l'appel
   (ex. `{"tools":true}`).
5. **Niveau de service** : `fast` / `economy` / `standard` / `advanced` / `specialized` /
   `fallback` — repli tolérant si le niveau demandé n'a aucun candidat.
6. **Budget** : budget mensuel dépassé → seuls les modèles gratuits restent éligibles
   (gratuit ≠ illimité) ; budget épuisé → code `BUDGET_EXHAUSTED`, jamais de réponse inventée.
7. **Anti-double-routage** : un modèle ne peut pas être atteint deux fois (accès direct
   + agrégateur) — l'agrégateur est un **recours**, pas un doublon de facturation.
8. **Chaîne plafonnée** (`maxChainLength`, défaut 4) : anti-boucle de secours.

Résultat : `{ steps, skipReason }`. `skipReason` est explicite :
`NO_CONFIGURED_PROVIDER` · `BUDGET_EXHAUSTED` · `NO_MATCHING_MODEL`.

### Ce qui reste à brancher pour le routage par tâche

- [ ] Table de correspondance **tâche → rôle** (aujourd'hui les rôles sont les 7 rôles
      métier Business Grow + les actions Studio).
- [ ] Politique de **coût maximum par tâche** (le budget est global/mensuel).
- [ ] Priorité par **latence observée** (le journal stocke `latency_ms`, pas encore exploité).
- [ ] Préférence **par espace** : Studio et Business Growth partagent le registre mais
      gardent des secrets et des quotas distincts.

---

## 4. Exécution, secours, journalisation (`engine.ts`)

```
runAiCall(request)
 ├─ buildAiChain() → chaîne de modèles
 ├─ pour chaque étape (max N) :
 │    ├─ adaptateur.buildRequest() → URL + en-têtes + corps
 │    ├─ fetch (injecté : testable sans réseau)
 │    ├─ adaptateur.parse() → contenu + tokens
 │    └─ échec → AiProviderError(code) → étape suivante, `fallbackFrom` renseigné
 └─ journal : ai_calls_log (space, task_key, provider, model, attempt,
              status, error_code, tokens, latence, coût, fallback_from)
```

- **Codes d'erreur normalisés** : `AI_NOT_CONFIGURED`, `AI_AUTH_FAILED`,
  `AI_RATE_LIMITED`, `AI_UNAVAILABLE`, `AI_TIMEOUT`, `AI_INVALID_RESPONSE`,
  `AI_EMPTY_RESPONSE`, `BUDGET_EXHAUSTED`, `NO_VERIFIED_PROVIDER`…
- **Aucune réponse fabriquée** : un échec fournisseur remonte tel quel (code + message).
- **Coût** : calculé à partir des tokens réels × prix du registre (`cost_in` / `cost_out`) ;
  un prix `NULL` reste `NULL` — il n'est jamais estimé.

### Suivi des consommations déjà en place

| Besoin | Mécanisme existant |
|---|---|
| Journal par appel | `saas_business.ai_calls_log` |
| Coût par appel | colonnes `cost_input_usd` / `cost_output_usd` |
| Budget mensuel + seuil d'alerte | réglages admin (`vyora_ai_admin_*`) |
| Plafond quotidien | `max_daily_cost_usd` |
| Plafonds fournisseur | migrations `20261111144107`, `20261112070000`, `20261112090000` |
| Santé fournisseur/modèle | `ai_provider_health_checks` + cron quotidien |
| Interface de pilotage | admin *Contrôle IA* (`src/pages/admin/AiCoreControl.tsx`) |

---

## 5. Mémoire persistante de l'agent

Tables et fonctions (migration `20261115100000_vyora_ai_core_registry.sql`) :

- `saas_business.ai_memories` : `category` (company, user, decision, conversation,
  domain, operational, document), `content`, `embedding` (768 dims), `valid_until`.
- `ai_memory_save` · `ai_memory_search` (similarité cosinus) · `ai_memory_list` ·
  `ai_memory_forget` · `ai_memory_set_valid`.
- Exécution réservée au rôle `bg_edge` (jamais `authenticated`, jamais `anon`).
- Indexation **HNSW** (pgvector) créée uniquement si l'extension est disponible.

**À faire pour la mémoire multi-fournisseurs :**
- [ ] Embeddings servis par un fournisseur **vérifié** (aujourd'hui `embeddinggemma-2-cf`
      est au catalogue Cloudflare mais non vérifié).
- [ ] Politique de rétention et d'effacement par catégorie (le droit à l'effacement
      existe déjà via `ledger_account_erasure` ; l'étendre aux mémoires).
- [ ] Résumé périodique des conversations longues (compaction) avant saturation de contexte.

---

## 6. Sécurité

| Risque | Mitigation en place |
|---|---|
| Clé exposée au navigateur | aucune clé dans le bundle ; `.env.example` ne contient que des noms |
| Clé en base | le registre ne stocke **que** l'état (`configured/missing`), jamais la valeur |
| Fuite par les logs | aucun secret journalisé ; seuls provider/modèle/statut/coût |
| Escalade de privilèges | fonctions d'administration vérifient `ugc_is_admin()` **à l'intérieur** |
| Accès direct à l'API | `EXECUTE` révoqué pour `anon` sur toutes les façades sensibles |
| Dépassement de coût | plafonds fournisseur + budget mensuel + plafond quotidien |
| Modèle non testé servi | `verified` obligatoire, santé < 24 h |

**Rappels pour les nouvelles intégrations :**
1. Ne jamais mettre une clé dans une migration, un document ou un test.
2. Ne jamais élargir un `grant` pour « faire marcher » une fonction.
3. Toute nouvelle façade expose le **minimum** d'information (pas d'e-mail, pas d'id utilisateur).

---

## 7. Plan d'intégration d'un nouveau fournisseur (procédure)

```
1. Fiche remplie            → docs/moteur-ia-fournisseurs.md (§ dédié)
2. Secret déposé            → Supabase Edge Functions → Secrets
3. Adaptateur               → supabase/functions/_shared/ai-core/adapters.ts
4. Registre                 → migration additive : ai_providers + ai_models (enabled=false)
5. Sonde                    → vyora-ai { action: "health" } ou admin → Contrôle IA
6. Vérification             → modèle `verified` + santé < 24 h
7. Routage                  → ai_routing_rules (priorité selon coût/capacité)
8. Budget                   → plafond fournisseur + budget mensuel
9. Test bout en bout        → tests/ai-core.test.ts + un appel réel contrôlé
10. Documentation           → README + journal des migrations
```

**Règles de migration :** toujours additive (`add column if not exists`,
`on conflict do nothing`), jamais destructive, jamais de `drop` de données existantes.

---

## 8. Tests existants à étendre

| Fichier | Couverture actuelle |
|---|---|
| `tests/ai-core.test.ts` | adaptateurs, routeur, moteur, secours, budget |
| `tests/ai-core-admin.test.tsx` | interface de contrôle admin |
| `tests/business-grow-providers.test.ts` | états des fournisseurs métier |
| `tests/provider-health-cron.test.ts` | surveillance planifiée |
| `tests/provider-spend-caps.test.ts` | plafonds de dépense |

**À ajouter pour chaque fournisseur :** un test de construction de requête (URL,
en-têtes, corps), un test de parsing (tokens, contenu vide, erreur), et un test
« modèle non vérifié → jamais routé ».

---

## 9. État réel au 2026-11-14 (à ne pas surinterpréter)

- ✅ **Le catalogue de fournisseurs n'est plus écrit dans le code** : il est lu
  dans le registre (`ai_providers`). Ajouter un fournisseur = une ligne de
  registre + un secret Edge (`vyora_ai_admin_provider_upsert`).
- ✅ Un gabarit de protocole `openai` suffit pour tout fournisseur
  OpenAI-compatible, connu ou non du code.
- ✅ Registre, budget, plafonds, journal, santé, interface admin, mémoire
  persistante : en place et testés.
- ✅ Groq et Gemini vérifiés en production (dernier contrôle : 2026-11-12).
- ⛔ **Aucune intégration de fournisseur n'est en cours.** La consigne du
  2026-11-14 est explicite : réception et documentation seulement, jusqu'à la
  phrase d'autorisation « COMMENCE L'INTÉGRATION DES FOURNISSEURS IA. »
- ⛔ **Mistral est reporté** (offre payante) : aucune démarche, aucune clé, aucune
  vérification. Sa ligne de registre reste telle quelle, inactive.
- ⚠️ Les identifiants de modèles déjà présents au catalogue proviennent de la
  documentation officielle consultée à la date indiquée : **à reconfirmer** avec
  les fiches de réception avant toute activation.
- ⚠️ Aucun test de production payant n'a été exécuté pour les fournisseurs non
  vérifiés.

### 9.1 Procédure de réception d'un fournisseur (sans intégration)

1. **Réception** : nom, informations d'accès (sans jamais recopier une clé),
   documentation officielle, précisions utiles.
2. **Identification** : fiche créée dans [`fournisseurs-ia/`](./fournisseurs-ia/README.md).
3. **Examen** : protocole, authentification, URL de base, modèle de coût,
   régions, limites *annoncées* (ou « non publié » — jamais deviné).
4. **Documentation** : caractéristiques, modèles annoncés, capacités annoncées,
   informations manquantes, état de préparation.
5. **Aucune intégration** : pas de ligne de registre activée, pas de clé, pas
   d'appel réseau, pas de sonde.
