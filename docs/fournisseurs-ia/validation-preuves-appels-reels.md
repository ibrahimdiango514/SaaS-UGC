# VYORA — Validation des fournisseurs IA : preuves d'appels réels

> **Date des mesures :** 2026-11-15 (UTC).
> **Branche :** `arena/bfcedd89-saas-ugc` — PR ouverte vers `develop` (aucune fusion sans autorisation).
> **Environnement :** projet Supabase `xbuuhfwobrafcbgtdgjx`, Edge Functions actives.
> **Règle appliquée :** aucun fournisseur n'est déclaré opérationnel sans une
> complétion réellement servie et enregistrée. Chaque ligne ci-dessous renvoie à
> un identifiant de requête `pg_net` consultable dans `net._http_response`.

---

## 1. Ce qui a changé dans la méthode de preuve

La sonde `vyora-ai-providers` prouvait qu'un fournisseur **répond**. Elle ne
prouvait pas que le moteur le **choisit** — deux questions distinctes, et un
fournisseur sain peut être inatteignable : `buildAiChain()` écarte au premier
filtre dur tout fournisseur absent de l'ensemble des « configurés », et
`vyora-ai` transmettait un ensemble **vide** en comptant sur la résolution par
`api_key_env`. Ce chemin n'était vérifiable nulle part.

Une action `route` a donc été ajoutée à `vyora-ai-providers` :

| Mode | Effet | Facturation |
|---|---|---|
| défaut (dry-run) | renvoie la chaîne de décision complète : rang, fournisseur, modèle, score, raison, coûts | **aucune** — zéro requête fournisseur |
| `call: true` | exécute la vraie complétion via `runAiCall()` et renvoie **chaque tentative** dans l'ordre | une seule complétion |

`avoid` et `prefer` sont des mécanismes **du moteur** (dernier échec connu /
préférence d'appel), exposés pour cibler un fournisseur précis. `avoid` est une
pénalité de score (−35), pas un retrait : la chaîne n'est jamais vidée.

---

## 2. Preuves d'appels réels routés

Toutes les requêtes ont été émises **par le moteur de production**
(`runAiCall` → `buildAiChain` → adaptateur du registre), pas par un appel
direct au fournisseur. Chacune a échoué sur son premier choix (groq,
`AI_EMPTY_RESPONSE`) puis servi par un second fournisseur : c'est précisément la
démonstration du fallback.

### 2.1 Gonka — `pg_net` **9393** → HTTP 200

```
modèle servi      : deepseek-ai/DeepSeek-V4-Flash-0731
clé de registre   : deepseek-ai-deepseek-v4-flash-0731
routé par         : catalog (score 112)
tentative 1       : groq / openai-gpt-oss-120b → AI_EMPTY_RESPONSE (228 ms)
tentative 2       : gonka → success (1 273 ms)
resultat          : ok=true, 24 tokens in, 64 tokens out
contenu           : 227 caractères
coût estimé       : 0,000009 USD
```

### 2.2 OpenRouter — `pg_net` **9395** → HTTP 200

```
modèle servi      : baidu/ernie-5.5-flash-preview:free
clé de registre   : ernie-5.5-flash-free
routé par         : catalog (score 109)
tentative 1       : groq / openai-gpt-oss-120b → AI_EMPTY_RESPONSE (218 ms)
tentative 2       : openrouter → success (1 008 ms)
resultat          : ok=true, 44 tokens in, 12 tokens out
coût estimé       : 0 USD (modèle gratuit)
```

### 2.3 LLM7.io — `pg_net` **9400** → HTTP 200

```
modèle servi      : default  (alias documenté ; le fournisseur annonce codestral-latest)
clé de registre   : default
routé par         : catalog (score 118, bonus de préférence explicite)
tentative 1       : groq / openai-gpt-oss-120b → AI_EMPTY_RESPONSE (322 ms)
tentative 2       : llm7 → success (1 251 ms)
resultat          : ok=true, 21 tokens in, 2 tokens out
coût estimé       : null (prix non publié — jamais estimé)
```

> **Note sur `default` :** LLM7 n'énumère pas cet alias dans son catalogue. Il est
> **déclaré** par l'opérateur (`ai_providers.probe_model`), et une complétion
> réelle l'a servi. Une déclaration explicite n'est pas une inférence.

---

## 3. État réel des cinq fournisseurs

| Fournisseur | État | Preuve | Modèle testé | Protocole | Coût mesuré | Restriction |
|---|---|---|---|---|---|---|
| **OpenRouter** | **OPERATIONAL** | routé + servi (9395) | `baidu/ernie-5.5-flash-preview:free` | OpenAI-compatible REST | 0 USD | Le catalogue ne publie qu'**un** modèle vérifié ; les autres sont `unverified` faute de sonde. |
| **Gonka Broker** | **OPERATIONAL** | routé + servi (9393) | `deepseek-ai/DeepSeek-V4-Flash-0731` | OpenAI-compatible REST | 0,000009 USD | Modèle vérifié limité à la capacité `writing`. |
| **LLM7.io** | **OPERATIONAL** | routé + servi (9400) | `default` | OpenAI-compatible REST | `null` (non publié) | Capacité `writing` seule ; alias non catalogué. |
| **Ollama Cloud** | **BLOCKED** (crédits) | 402 `PROVIDER_PAYMENT_REQUIRED` (sonde 9284) | `beam` | REST | — | Le compte répond « Add usage credits or subscribe ». Aucune vérification de modèle possible sans crédit. **Rien n'est déclaré opérationnel.** |
| **Cloudflare** | **NOT_CONFIGURED** (secrets) | `PROVIDER_ACCOUNT_ID_MISSING` (sonde 9284) | — | Workers AI / AI Gateway | — | Deux secrets absents **par leur nom** : `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID`, `BUSINESS_GROW_CLOUDFLARE_GATEWAY_ID`. Voir § 5. |

**Aucun fournisseur n'est déclaré opérationnel sans preuve d'appel réussi.**
Ollama et Cloudflare restent bloqués et sont signalés comme tels.

---

## 4. Routage : capacités réelles et plafond de chaîne

Le diagnostic dry-run (identifiants `pg_net` **9387** et **9388**) montre les
chaînes réelles calculées par le routeur de production.

### Rôle `business_analysis` (capacité `reasoning`)

| rang | fournisseur | modèle | score | raison |
|---|---|---|---|---|
| 1 | groq | `openai-gpt-oss-120b` | 161 | `role_rule` |
| 2 | gemini | `gemini-2.5-flash` | 131 | `role_rule` |
| 3 | groq | `openai-gpt-oss-20b` | 159 | `role_rule` |
| 4 | groq | `qwen-qwen3.8-27b` | 156 | `role_rule` |

**Gonka et LLM7 sont absents** : leurs modèles vérifiés ne déclarent que
`writing`. C'est un **filtre de capacité**, pas un défaut de configuration.

### Rôle `content_strategy` (capacité `writing`)

| rang | fournisseur | modèle | score | raison |
|---|---|---|---|---|
| 1 | groq | `openai-gpt-oss-120b` | 161 | `role_rule` |
| 2 | gemini | `gemini-2.5-flash` | 131 | `role_rule` |
| 3 | **gonka** | `deepseek-ai-deepseek-v4-flash-0731` | 112 | `catalog` |
| 4 | **openrouter** | `ernie-5.5-flash-free` | 109 | `catalog` |

**LLM7 est 5ᵉ** (score ≈ 93) : *pool* de 10 modèles vérifiés, diversité
« 1 modèle par fournisseur », plafond de chaîne = **4**. Joignable par
`prefer` (preuve 9400) ou lorsque groq/gemini sont indisponibles.

### Garanties vérifiées par tests (17 tests, `tests/ai-route-diagnostic.test.ts`)

- modèle non `verified` **jamais** routé ;
- capacité manquante **jamais** contournée (ni par `prefer`, ni par le catalogue) ;
- fournisseur sans clé **jamais** tenté ;
- `account_id_env` / `gateway_id_env` exigés quand le registre les déclare ;
- ni fournisseur ni couple fournisseur|modèle répété → **pas de double appel** ;
- `prefer` renverse le départage mais **ne prime pas** sur une règle de rôle curatée ;
- `avoid` rétrograde sans vider la chaîne.

---

## 5. Ce qui reste bloqué — et ce qu'il faut fournir

### 5.1 Cloudflare

Secrets **absents**, vérifiés par leur nom uniquement :

| Secret à créer | Rôle |
|---|---|
| `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID` | Identifiant de compte Cloudflare (Workers AI) |
| `BUSINESS_GROW_CLOUDFLARE_GATEWAY_ID` | Identifiant de passerelle AI Gateway |

Le jeton `BUSINESS_GROW_CLOUDFLARE_API_TOKEN` **est déjà présent**. Il doit
disposer des permissions : *Workers AI : Read* et *AI Gateway : Read*.

Les deux vérifications seront faites **séparément** (Workers AI, puis AI
Gateway), sur les endpoints officiellement documentés, sans aucune valeur de
secret affichée.

### 5.2 Ollama

Bloqué par les **crédits du compte**, pas par la configuration : la sonde reçoit
un `402` avec le message du fournisseur. Aucune correction de code ne débloque
cette situation.

---

## 6. Deux défauts de traçabilité trouvés et corrigés pendant la validation

La validation a servi de test d'intégration réel : elle a révélé deux pertes de
données silencieuses, toutes deux invisibles en test unitaire.

### 6.1 Journal de routage — colonnes vides

Le moteur émet sa décision en camelCase (`chosenProvider`, `roleKey`,
`skipReason`) ; la RPC `vyora_ai_log_routing` lit `p_payload->>'chosen_provider'`,
`->>'role_key'`, `->>'skip_reason'`. Les deux hôtes transmettaient l'objet **tel
quel** : PostgreSQL renvoyait NULL pour chaque clé absente, sans erreur. Comme
la journalisation est « non bloquante » par conception, la perte était
totalement muette.

**Constat :** quatre lignes avec `chosen_provider`, `chosen_model` et `role_key`
à NULL alors que la chaîne était bien enregistrée.

**Correction :** `routingLogPayload()` porte la conversion, à un seul endroit.
**Preuve après correction** (`ai_routing_log`, 2026-11-15 05:08:23) :
`role_key = content_strategy`, `chosen_provider = llm7`, `chosen_model = default`.

### 6.2 Consommation — dépenses invisibles

Le diagnostic appelait `vyora_ai_log_call` avec un unique `p_payload` jsonb
groupé, alors que la RPC attend des paramètres **plats**, un appel par tentative.
Résultat : aucune ligne dans `ai_calls_log` — la dernière datait de la veille —
donc une dépense réelle non suivie.

**Correction :** boucle sur les tentatives, coût imputé à la seule tentative
finale réussie, `fallback_from` renseigné.
**Preuve après correction** (`ai_calls_log`, 2026-11-15 05:11:19) :

```
task_key      : content_strategy
provider_key  : gonka
model_key     : deepseek-ai-deepseek-v4-flash-0731
status        : success
tokens        : 24 in / 64 out
latence       : 11 933 ms
coût          : 0,000002 USD (entrée) + 0,000006 USD (sortie)
```

---

## 7. Sécurité

- Les clés vivent **exclusivement** dans les secrets Edge Function ;
- vérification **par nom** uniquement : l'API de gestion renvoie des valeurs
  hachées, jamais le secret ;
- aucune valeur n'apparaît dans un fichier, un commit, un log ou le frontend ;
- `error_detail` de la sonde est tronqué et purgé de tout jeton (`redactSecrets`).

---

## 8. Vérifications techniques

| Vérification | Résultat |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 1 297 / 1 298 (1 échec **préexistant** : `business-modules.test.tsx`, sans lien) |
| `npm run build` | ✓ 21 s |
| `npm run check:edge-imports` | conforme au bundler Deno |
| Parité chargeur ↔ générateur | 12 / 12 verts |
| Intégrité des artefacts en base | `vyora-ai` 9 tranches / 16 120 car. / md5 `065344ce…` ; `vyora-ai-providers` 9 tranches / md5 `a9554b73…` |
| Edge Functions déployées | `vyora-ai` **v9** ACTIVE, `vyora-ai-providers` **v10** ACTIVE (`verify_jwt: false`) |
| Journal de routage | corrigé et prouvé (`role_key`, `chosen_provider`, `chosen_model` renseignés) |
| Consommation réelle | corrigée et prouvée (`ai_calls_log` : gonka, 24/64 tokens, coût mesuré) |
