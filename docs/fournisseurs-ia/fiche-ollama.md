# Fiche fournisseur — Ollama

> **Statut : `documenté`** — reçu le 2026-11-14, clé déposée le 2026-11-14.
> **Aucune intégration, aucune activation, aucun appel réseau.**
> Ce fichier ne contient **aucune clé**, seulement des **noms de variables**.

---

## 1. Identification

| Champ | Valeur |
|---|---|
| Nom commercial | **Ollama** (accès cloud direct) |
| Éditeur / opérateur | Ollama |
| Nature | **Inférence hébergée** de modèles ouverts, accessible sans installation locale |
| Reçu le | 2026-11-14 |
| Source de la transmission | Chat Arena (propriétaire du produit) |
| Fiche rédigée le | 2026-11-14, d'après `docs.ollama.com` |

## 2. Accès

| Élément | Valeur |
|---|---|
| Variable de secret (déposée) | `BUSINESS_GROW_OLLAMA_API_KEY` |
| Présence vérifiée | Oui — par **nom** uniquement |
| Durée de vie de la clé | **n'expire pas** (documentation officielle) ; révocable dans les réglages du compte |
| Rotation | aucune rotation systématique prévue |

Variables prévues le jour de l'intégration : `BUSINESS_GROW_OLLAMA_API_KEY`,
`BUSINESS_GROW_OLLAMA_MODEL`, `BUSINESS_GROW_OLLAMA_BASE_URL`,
`BUSINESS_GROW_OLLAMA_MODELS_URL`.

## 3. Documentation consultée

| Page | Contenu retenu |
|---|---|
| `docs.ollama.com/llms.txt` | index de la documentation |
| `docs.ollama.com/api/authentication.md` | URL cloud, en-tête `Authorization: Bearer`, absence d'expiration des clés |
| `docs.ollama.com/api/openai-compatibility.md` | compatibilité OpenAI, `https://ollama.com/v1`, limites du cloud |
| `docs.ollama.com/cloud` | offres cloud (page tronquée — complétée par les pages `api/*`) |

Consultées le 2026-11-14.

## 4. Caractéristiques

| Champ | Valeur |
|---|---|
| Protocole | **API native Ollama** (`/api/chat`, `/api/generate`, `/api/embed`…) **et** compatibilité **OpenAI** (`/v1/...`) **et** compatibilité **Anthropic** (`/v1/messages`) |
| URL de base — native | `https://ollama.com/api` |
| URL de base — OpenAI-compatible | `https://ollama.com/v1` |
| Authentification | `Authorization: Bearer <clé>` — **obligatoire pour le cloud** ; `x-api-key` seul n'est **pas** accepté sur `/v1/messages` |
| Endpoints documentés | `POST /api/chat`, `POST /api/generate`, `POST /api/embed`, `POST /api/tags` (catalogue local), `POST /v1/chat/completions`, `POST /v1/responses` (sans état), `POST /v1/messages` |
| Installation locale requise | **Non** — l'accès cloud direct ne nécessite ni binaire ni serveur local |
| Régions / résidence | **non publié** |

> ⚠️ Le serveur **local** `http://localhost:11434` n'exige aucune authentification :
> ce n'est **pas** le mode visé ici. SORAHNEX utilisera l'accès **cloud direct**, qui
> exige la clé. Ne jamais confondre les deux bases URL.

## 5. Modèles annoncés

- Seuls les **modèles cloud** sont disponibles via l'accès direct ; catalogue
  public : `ollama.com/search?c=cloud`.
- Suffixe `-cloud` sur les identifiants de modèles cloud (ex. `gpt-oss:120b-cloud`).
- Exemples cités par la documentation consultée : `gemma4:31b`, `gpt-oss:120b-cloud`,
  `qwen3:8b`, `qwen3-vl:8b` (vision).
- **Aucune liste figée ici** : le registre lira le catalogue au moment de
  l'intégration.

## 6. Capacités annoncées

| Capacité | État |
|---|---|
| Chat / complétion | Oui |
| Streaming | Oui |
| Vision (image en entrée) | Oui sur les modèles dédiés (ex. `qwen3-vl`) |
| Outils / function calling | Selon modèle — **à confirmer côté cloud** |
| **Sorties structurées (JSON schema)** | **Non** — non pris en charge sur les modèles cloud |
| Embeddings | Oui via `/api/embed` — **disponibilité cloud à confirmer** |
| Réponses avec état (`store`) | **Non** sur le cloud |
| Recherche web intégrée via `/v1/responses` | **Non** sur le cloud |
| Rejeu d'appels d'outils libres | **Non** sur le cloud |
| Compatibilité Anthropic | Oui |

## 7. Tarification et quotas

| Élément | Valeur |
|---|---|
| Modèle économique | Offre cloud avec **quota d'usage gratuit** puis formule payante |
| Prix au jeton | **non publié dans les pages consultées** → à confirmer |
| Abonnement | Formule payante annoncée (montant **non vérifié**) |
| Quotas de débit | **non publiés dans les pages consultées** → à confirmer |
| Expiration des clés | aucune |

## 8. Informations manquantes / points à confirmer

1. **Tarifs** cloud (prix au jeton et/ou abonnement) — non vérifiés ici.
2. **Quotas** de débit de l'offre cloud.
3. Endpoint de **listing des modèles cloud** (l'API `/api/tags` liste les modèles
   locaux ; l'équivalent cloud est **à confirmer**).
4. Disponibilité des **embeddings** sur l'accès cloud direct.
5. Régions / résidence des données.

## 9. État de préparation

- [x] reçu
- [x] clé déposée et vérifiée **par nom**
- [x] documenté
- [ ] prêt — **en attente de la phrase d'autorisation**

**Passerelle pressentie** : `adapter_kind = openai` avec
`default_base_url = https://ollama.com/v1`. Alternative native possible
(`https://ollama.com/api`) mais elle exigerait un adaptateur spécifique — **décision
reportée à l'intégration**, et sans écriture de code aujourd'hui.
