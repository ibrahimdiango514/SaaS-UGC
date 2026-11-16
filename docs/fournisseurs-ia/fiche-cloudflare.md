# Fiche fournisseur — Cloudflare (Workers AI + AI Gateway)

> **Statut : `reçu` + `documenté` — mais incomplet : il manque 2 identifiants.**
> Reçu le 2026-11-14, jeton déposé le 2026-11-14.
> **Aucune intégration, aucune activation, aucun appel réseau.**
> Ce fichier ne contient **aucune clé**, seulement des **noms de variables**.

---

## 1. Identification

| Champ | Valeur |
|---|---|
| Nom commercial | **Cloudflare — Workers AI**, exposé via **AI Gateway** |
| Éditeur / opérateur | Cloudflare, Inc. |
| Nature | **Inférence hébergée** (modèles `@cf/…` sur le réseau Cloudflare) + **passerelle** (AI Gateway : journalisation, cache, limitation de débit, repli, facturation unifiée) |
| Reçu le | 2026-11-14 |
| Source de la transmission | Chat Arena (propriétaire du produit) |
| Fiche rédigée le | 2026-11-14, d'après `developers.cloudflare.com` |

## 2. Accès

| Élément | Valeur |
|---|---|
| Variable de secret (déposée) | `BUSINESS_GROW_CLOUDFLARE_API_TOKEN` |
| Présence vérifiée | Oui — par **nom** uniquement |
| **Forme du jeton fourni** | préfixe **`cfut_`** → d'après la documentation officielle des formats de jetons, un **jeton d'API utilisateur** (« User API Token », jeton à portée limitée, suffixé d'une somme de contrôle) |
| Portée réelle du jeton | **inconnue à ce stade** — voir §8. Aucune vérification possible sans appel réseau (`GET /user/tokens/verify`), interdit avant l'autorisation |
| Rotation | aucune rotation systématique prévue |

Variables prévues le jour de l'intégration :
`BUSINESS_GROW_CLOUDFLARE_API_TOKEN`, `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID`,
`BUSINESS_GROW_CLOUDFLARE_GATEWAY_ID`, `BUSINESS_GROW_CLOUDFLARE_MODEL`,
`BUSINESS_GROW_CLOUDFLARE_BASE_URL`.

> 🔎 **Précision utile (documentation des formats de jetons, 2026-10-23)** :
> `cfk_` = clé globale (accès total), `cfut_` = **jeton utilisateur** à portée
> limitée, `cfat_` = jeton de compte (non lié à un utilisateur), `cfoat_` = jeton
> OAuth Wrangler. Le bouton *Create authentication token* de l'AI Gateway génère un
> jeton utilisateur doté de la permission **`Run`** sur AI Gateway — donc cohérent
> avec un préfixe `cfut_`.

## 3. Documentation consultée

| Page | Contenu retenu |
|---|---|
| `developers.cloudflare.com/ai-gateway/configuration/authentication/` | en-têtes d'authentification, irréversibilité, portée des permissions, endpoints |
| `developers.cloudflare.com/ai-gateway/usage/rest-api/` | 4 endpoints, nommage des modèles, en-tête `cf-aig-gateway-id` |
| `developers.cloudflare.com/ai-gateway/usage/chat-completion/` | endpoint `/compat/chat/completions` (déprécié pour un appel mono-modèle) |
| `developers.cloudflare.com/workers-ai/platform/pricing/` | Neurons, allocation gratuite, prix par modèle |
| `developers.cloudflare.com/workers-ai/models/` + `llms.txt` | catalogue (75 modèles annoncés) |
| `developers.cloudflare.com/fundamentals/api/get-started/token-formats/` | préfixes et portées des jetons |

Consultées le 2026-11-14.

## 4. Caractéristiques

| Champ | Valeur |
|---|---|
| Protocole | **REST** ; API Workers AI historique (`/ai/run`, enveloppe `model` + `input`) et endpoints **OpenAI-compatibles** (`/ai/v1/chat/completions`, `/ai/v1/responses`) + **Anthropic-compatible** (`/ai/v1/messages`) |
| URL de base — **REST (recommandé)** | `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai` |
| URL de base — **passerelle** (fournisseur natif) | `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}` |
| Endpoint unifié passerelle | `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/compat/chat/completions` — **déprécié** pour un appel mono-modèle, conservé pour compatibilité et pour les routes dynamiques |
| Authentification — REST | `Authorization: Bearer <jeton>` — nécessite la permission **Account › Workers AI › Read** |
| Authentification — passerelle | `cf-aig-authorization: Bearer <jeton>` |
| `MODELS_URL` | **non publié** — il n'existe pas d'endpoint HTTP public de catalogue listant les modèles au format `@cf/…` (le catalogue vit dans la documentation). À confirmer |
| Nommage des modèles | `@cf/auteur/modele` (ex. `@cf/moonshotai/kimi-k2.6`) ; modèles tiers via la passerelle : `auteur/modele` |
| Modèles Workers AI via REST | exiger l'en-tête **`cf-aig-gateway-id`** en plus du jeton |
| Gateway `default` | créée automatiquement à la première requête |
| Régions / résidence | réseau mondial Cloudflare ; résidence **non publiée** pour Workers AI |

### Point d'attention sur les permissions (documentation officielle)

- Les jetons **AI Gateway** (`Read`, `Run`, `Edit`) sont **à portée de compte** : un
  jeton `Run` peut appeler **toutes** les passerelles du compte.
- Un jeton qui ne porte **que** la permission AI Gateway renvoie **`401` (code 10000)**
  sur les endpoints `/accounts/{id}/ai/*`. Pour ces endpoints il faut
  **Workers AI › Read**.
- L'authentification d'une passerelle est **irréversible** une fois activée.

## 5. Modèles annoncés

Le catalogue officiel annonce **75 modèles** (texte, embeddings, image, TTS, ASR,
vidéo). Extrait **non exhaustif** et **non figé** — relevé dans la documentation à la
date de consultation :

| Identifiant `@cf/…` | Type |
|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | texte |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | texte |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | texte (multimodal) |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | texte (raisonnement) — **offre payante requise** |
| `@cf/zai-org/glm-5.3-flash` | texte (multimodal) — **offre payante requise** |
| `@cf/qwen/qwen3-30b-a3b-fp8` | texte |
| `@cf/baai/bge-m3` | embeddings multi-fonctions |
| `@cf/baai/bge-large-en-v1.5` | embeddings (1 024 dim) |
| `@cf/black-forest-labs/flux-2-klein-4b` | image |
| `@cf/deepgram/aura-2-en` | synthèse vocale |
| `@cf/deepgram/nova-3` | transcription |

## 6. Capacités annoncées

| Capacité | État |
|---|---|
| Chat / complétion | Oui |
| Streaming | Oui |
| Embeddings | Oui (`@cf/baai/…`) |
| Raisonnement | Selon modèle |
| Outils / function calling | Selon modèle — **à confirmer par modèle** |
| Réponses structurées | Selon modèle |
| Image (génération) | Oui (FLUX…) |
| Audio (TTS / ASR) | Oui |
| Requêtes longues en arrière-plan + webhook | Oui via `/ai/run` (`background: true`, `webhookUrl`) |
| Cache / limitation de débit / repli / DLP | Oui, via AI Gateway |

## 7. Tarification et quotas

| Élément | Valeur |
|---|---|
| Unité | **Neuron** |
| Prix | **0,011 $ / 1 000 Neurons** (soit 11 $ / million de Neurons) |
| Allocation gratuite | **10 000 Neurons / jour** (offre Workers Free comme Paid), remise à zéro à 00:00 UTC |
| Au-delà de l'allocation | offre **Workers Paid** requise |
| Modèles payants | `@cf/moonshotai/kimi-k2.6`, `@cf/zai-org/glm-5.3`, `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, `@cf/thinkingmachines/inkling-2-small`… → **Workers Paid** ou **crédits AI Gateway prépayés** (« Unified billing ») |
| Exemples de prix au million de jetons | `llama-3.3-70b-instruct-fp8-fast` : 0,293 $ entrée / 2,253 $ sortie · `llama-3.1-8b-instruct-fp8-fast` : 0,045 $ / 0,384 $ · `deepseek-v4-flash-0731` : 0,440 $ / 1,320 $ |
| Quotas de débit | **non publiés en valeur chiffrée** dans les pages consultées (les modèles « frontier » payés en crédits reçoivent des limites plus élevées) |

## 8. Informations manquantes — **blocage actuel**

Pour construire l'URL de la passerelle
`https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}/…` **et** pour savoir
quel endpoint est utilisable, il manque :

1. **`ACCOUNT_ID`** — identifiant du compte Cloudflare (32 caractères hexadécimaux),
   visible dans le tableau de bord ou via `wrangler whoami`.
2. **`GATEWAY_ID`** — nom/identifiant de la passerelle AI Gateway.
3. **Portée exacte du jeton `cfut_`** fourni :
   - s'il porte **AI Gateway › Run** → utilisable sur `gateway.ai.cloudflare.com`
     (en-tête `cf-aig-authorization`) ;
   - s'il porte **Workers AI › Read** → utilisable sur
     `api.cloudflare.com/…/ai/v1/chat/completions` (en-tête `Authorization`) ;
   - s'il ne porte que l'un des deux, **un seul** des deux chemins fonctionnera.
     À vérifier par `GET /user/tokens/verify` + lecture des permissions — **le jour de
     l'intégration**, pas avant.
4. Offre du compte (Workers Free ou Paid) : détermine l'accès aux modèles payants.
5. Existence d'un endpoint de catalogue HTTP : à confirmer.

> Ces éléments ne sont **pas** des secrets sensibles au même titre qu'une clé, mais
> ils sont nécessaires : ils seront demandés au propriétaire **au moment de
> l'intégration**, en même temps que le reste.

## 9. État de préparation

- [x] reçu
- [x] jeton déposé et vérifié **par nom**
- [x] documenté
- [ ] **complet** — manque `ACCOUNT_ID` + `GATEWAY_ID` (+ portée du jeton)
- [ ] prêt — en attente de la phrase d'autorisation

**Passerelle pressentie** : `adapter_kind = cloudflare` (déjà supporté par le moteur),
avec `account_id_env = BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID`. Rien n'est écrit dans le
registre actif à ce stade.
