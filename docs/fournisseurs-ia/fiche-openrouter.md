# Fiche fournisseur — OpenRouter

> **Statut : `documenté`** — reçu le 2026-11-14, clé déposée le 2026-11-14.
> **Aucune intégration, aucune activation, aucun appel réseau.**
> Ce fichier ne contient **aucune clé**, seulement des **noms de variables**.

---

## 1. Identification

| Champ | Valeur |
|---|---|
| Nom commercial | **OpenRouter** |
| Éditeur / opérateur | OpenRouter (États-Unis) |
| Nature | **Passerelle multi-modèles** (routeur) : une seule API devant des centaines de modèles de dizaines de fournisseurs |
| Reçu le | 2026-11-14 |
| Source de la transmission | Chat Arena (propriétaire du produit) |
| Fiche rédigée le | 2026-11-14, d'après la documentation officielle `openrouter.ai/docs` |

## 2. Accès

| Élément | Valeur |
|---|---|
| Variable de secret (déposée) | `BUSINESS_GROW_OPENROUTER_API_KEY` |
| Présence vérifiée | Oui — par **nom** uniquement, dans les Edge Function Secrets SORAHNEX (projet `xbuuhfwobrafcbgtdgjx`) |
| Valeur | **jamais recopiée** ici, ni dans un commit, un log, un rapport ou le frontend |
| Rotation | aucune rotation systématique prévue |

Variables prévues le jour de l'intégration (noms seulement) :
`BUSINESS_GROW_OPENROUTER_API_KEY`, `BUSINESS_GROW_OPENROUTER_MODEL`,
`BUSINESS_GROW_OPENROUTER_BASE_URL`, `BUSINESS_GROW_OPENROUTER_MODELS_URL`.

## 3. Documentation consultée

| Page | Contenu retenu |
|---|---|
| `openrouter.ai/docs/quickstart` | URL de base, en-têtes, endpoints, catalogue live, routage UE |
| `openrouter.ai/docs/api_reference/limits` | quotas, budgets, erreurs `402` / `403` / `429`, `GET /api/v1/key` |
| `openrouter.ai/docs/llms.txt` | index de la documentation (découverte des pages) |

Consultées le 2026-11-14.

## 4. Caractéristiques

| Champ | Valeur |
|---|---|
| Protocole | **HTTP REST, compatible OpenAI** (+ endpoint `responses` de style OpenAI) |
| URL de base (production) | `https://openrouter.ai/api/v1` |
| URL de base (routage UE) | `https://eu.openrouter.ai/api/v1` — **Business / Enterprise uniquement**, avec un modèle éligible UE |
| Authentification | `Authorization: Bearer <clé>` |
| En-têtes d'attribution (optionnels) | `HTTP-Referer` (URL du site), `X-OpenRouter-Title` (nom de l'application) |
| Endpoints documentés | `POST /chat/completions`, `POST /responses`, `POST /embeddings`, `GET /models` (catalogue), `GET /key` (quota de la clé), `POST|PATCH|DELETE /keys` (gestion de clés, hors périmètre produit) |
| Streaming | Oui (SSE) |
| Régions / résidence | routage standard mondial ; routage en région UE sur offre Business/Enterprise |

## 5. Modèles annoncés

- **Le catalogue n'est pas figé** : il est exposé en direct par `GET /api/v1/models`
  (identifiants, prix, fenêtre de contexte, capacités). C'est la source à lire au
  moment de l'intégration — **aucun identifiant de modèle n'est recopié ici comme
  une liste**.
- Des **alias « latest »** existent (préfixe `~`, ex. `~openai/gpt-sol-latest`) et
  résolvent automatiquement la dernière version d'une famille.
- Des variantes **`:free`** existent, soumises à des quotas spécifiques (§7).
- Le choix du modèle sera piloté par le registre (`saas_business.ai_models`), pas
  par le code.

## 6. Capacités annoncées

| Capacité | État |
|---|---|
| Chat / complétion texte | Oui |
| Streaming | Oui |
| Outils / function calling | Oui (dépend du modèle choisi) |
| Réponses structurées | Oui (dépend du modèle) |
| Embeddings | Endpoint `POST /embeddings` documenté |
| Images / audio | Dépend du modèle routé ; **à confirmer** par lecture du catalogue |
| Bascule / repli entre modèles | Oui — repli automatique entre fournisseurs d'un même modèle, et `fallback models` configurables |
| Compatibilité Anthropic | **non documentée** dans les pages consultées → hors périmètre |

## 7. Tarification et quotas

**Tarification**
- Modèle économique : on paie les jetons au tarif du fournisseur routé, plus des
  frais de service OpenRouter. **Le taux exact des frais n'a pas été vérifié dans
  cette session → « à confirmer »**.
- Les prix par modèle sont exposés par `GET /api/v1/models`.
- Crédits prépayés sur le compte.

**Quotas vérifiés (documentation du 2026-11-14)**

| Limite | Valeur |
|---|---|
| Modèles **`:free`**, moins de 10 crédits achetés | **20 requêtes/min**, **50 requêtes/jour** |
| Modèles **`:free`**, au moins 10 crédits achetés | **20 requêtes/min**, **1 000 requêtes/jour** |
| Gestion de clés (`/keys`) | 10 000 requêtes/jour, remise à zéro à 00:00 UTC |
| Limite de rafale par IP | Variable selon l'endpoint ; pas d'en-tête `X-RateLimit-*` → attendre et réessayer |
| Modèles payants | Pas de plafond de requêtes côté plateforme ; limites = solde / budgets |

**Erreurs à gérer**

| Code | Cause | Réaction |
|---|---|---|
| `402` | solde insuffisant, plafond de clé atteint, ou **budget de dépenses en vol** saturé (`metadata.limit_source`) | lire `limit_source` ; si `openrouter_in_flight_budget` → attendre `Retry-After` ; si `openrouter_credits` → réduire `max_tokens` ou recharger |
| `403` | budget d'organisation / espace de travail / clé dépassé | attendre `metadata.resets_at` |
| `429` | quota plateforme **ou** limitation du fournisseur amont (`metadata.provider_code`) | backoff exponentiel, honorer `Retry-After` |

**Suivi du quota** : `GET /api/v1/key` renvoie `limit_remaining`, `budgets`,
`effective_budget`, `free_model_daily_requests`, `is_free_tier`. Utile pour une
sonde de disponibilité **non facturée** le jour de l'intégration.

## 8. Informations manquantes / points à confirmer

1. **Taux des frais de service** OpenRouter (non vérifié ici).
2. Modèle par défaut à retenir pour SORAHNEX (à décider via le registre, pas par défaut).
3. Éligibilité au **routage UE** (offre Business/Enterprise) — à confirmer si la
   résidence européenne devient une exigence.
4. Capacités multimodales réelles : à lire dans `GET /api/v1/models` au moment de
   l'intégration, pas à supposer.

## 9. État de préparation

- [x] reçu
- [x] clé déposée et vérifiée **par nom**
- [x] documenté
- [ ] prêt — **en attente de la phrase d'autorisation**

**Passerelle pressentie à l'intégration** : `adapter_kind = openai`
(API OpenAI-compatible), `is_aggregator = true` (routeur multi-fournisseurs).
Rien n'est écrit dans le registre actif à ce stade.
