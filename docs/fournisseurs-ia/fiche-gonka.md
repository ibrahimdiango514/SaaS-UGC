# Fiche fournisseur — Gonka Broker

> **Statut : `documenté`** — reçu le 2026-11-14, clé déposée le 2026-11-14.
> **Aucune intégration, aucune activation, aucun appel réseau.**
> Ce fichier ne contient **aucune clé**, seulement des **noms de variables**.

---

## 1. Identification

| Champ | Valeur |
|---|---|
| Nom commercial | **Gonka Broker** (proxy d'inférence) |
| Éditeur / opérateur | Gonka |
| Nature | **Passerelle d'inférence** exposant des modèles ouverts (MiniMax, DeepSeek, GLM, BGE) via une API compatible OpenAI |
| Reçu le | 2026-11-14 |
| Source de la transmission | Chat Arena (propriétaire du produit) |
| Fiche rédigée le | 2026-11-14, d'après `docs.gonkabroker.com` |

## 2. Accès

| Élément | Valeur |
|---|---|
| Variable de secret (déposée) | `BUSINESS_GROW_GONKA_API_KEY` |
| Présence vérifiée | Oui — par **nom** uniquement |
| Forme de la clé | préfixe `gnk-prx-…` (format annoncé, valeur non recopiée) |
| Rotation | aucune rotation systématique prévue |

Variables prévues le jour de l'intégration : `BUSINESS_GROW_GONKA_API_KEY`,
`BUSINESS_GROW_GONKA_MODEL`, `BUSINESS_GROW_GONKA_BASE_URL`,
`BUSINESS_GROW_GONKA_MODELS_URL`.

## 3. Documentation consultée

| Page | Contenu retenu |
|---|---|
| `docs.gonkabroker.com/` | URL de base, authentification, exemples |
| `docs.gonkabroker.com/reference/supported-models/` | catalogue annoncé |
| `docs.gonkabroker.com/reference/api-compatibility/` | compatibilités OpenAI / Anthropic, paramètres |

Consultées le 2026-11-14.

> ⚠️ **Homonymie à ne pas confondre** : `gonkabroker.com` / `proxy.gonkabroker.com`
> (ce fournisseur) ≠ `gonka.broker` / `api.gonka.broker`. La base URL retenue est
> celle de la documentation officielle : `proxy.gonkabroker.com`.

## 4. Caractéristiques

| Champ | Valeur |
|---|---|
| Protocole | **HTTP REST**, compatible **OpenAI** et compatible **Anthropic** |
| URL de base | `https://proxy.gonkabroker.com/v1` |
| Authentification | `Authorization: Bearer <clé>` (préfixe `gnk-prx-`) |
| Endpoints documentés | `POST /chat/completions`, `POST /completions`, `POST /embeddings`, `GET /models`, `GET /test-auth` |
| Vérification d'authentification | `GET /test-auth` — **sonde dédiée, non facturée** (à utiliser le jour de l'intégration ; **pas maintenant**) |
| Catalogues | `GET /v1/models` en direct |
| Régions / résidence | **non publié** |

## 5. Modèles annoncés

Identifiants **tels que publiés dans la documentation consultée** (le catalogue
live `GET /v1/models` reste la source de vérité au moment de l'intégration) :

| Identifiant | Type | Tarif annoncé (doc) |
|---|---|---|
| `MiniMaxAI/MiniMax-M2.7` | chat / raisonnement | ≈ **0,12 $ / M jetons** |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | chat | ≈ **0,10 $ / M jetons** |
| `zai-org/GLM-5.3-Flash` | chat | ≈ **0,10 $ / M jetons** |
| `BAAI/bge-m3` | embeddings (1 024 dimensions, 8 192 jetons) | **non publié** |

> Ces lignes ne sont **pas** une liste figée : elles documentent ce que la
> documentation annonce à la date de consultation. Le registre lira le catalogue live.

## 6. Capacités annoncées

| Capacité | État |
|---|---|
| Chat / complétion | Oui |
| Raisonnement | Oui — paramètre `reasoning_effort` (`none` désactive le raisonnement) |
| Sorties structurées | Oui — `response_format` : `text`, `json_object`, `json_schema` |
| Embeddings | Oui (`/embeddings`, modèle BGE-M3) |
| **Multimodal (image / audio)** | **Non** — non annoncé par la documentation |
| Streaming | Oui |
| Outils / function calling | **à confirmer** (non explicite dans les pages consultées) |
| Compatibilité Anthropic | Oui (endpoint de type `/v1/messages` annoncé côté compatibilité) |

## 7. Tarification et quotas

| Élément | Valeur |
|---|---|
| Unité de facturation | prix au **million de jetons** (annoncé par modèle) |
| Moyens de paiement | **non publié** dans les pages consultées |
| Quotas de débit | **non publiés** dans les pages consultées |
| Quota d'embeddings | **non publié** |

## 8. Informations manquantes / points à confirmer

1. **Quotas de débit** (requêtes/min, jetons/min) : non publiés → à confirmer.
2. **Moyens de paiement / solde** : non publiés.
3. **Function calling / outils** : à confirmer sur le catalogue live.
4. Résidence des données / régions : non publiée.
5. Distinction définitive avec l'homonyme `gonka.broker` : base URL retenue =
   `proxy.gonkabroker.com` (documentation officielle).

## 9. État de préparation

- [x] reçu
- [x] clé déposée et vérifiée **par nom**
- [x] documenté
- [ ] prêt — **en attente de la phrase d'autorisation**

**Passerelle pressentie** : `adapter_kind = openai`. Sonde d'authentification
prévue pour l'intégration : `GET https://proxy.gonkabroker.com/v1/test-auth`.
Rien n'est écrit dans le registre actif à ce stade.
