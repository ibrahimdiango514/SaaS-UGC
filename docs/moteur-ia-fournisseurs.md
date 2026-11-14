# VYORA — Fiche de renseignement des fournisseurs d'IA

> **Document de travail.** Il sert à recueillir les informations officielles de chaque
> fournisseur avant intégration dans le moteur IA de VYORA. Les cases marquées
> « à renseigner » sont vides volontairement : **aucune valeur n'est inventée**.
>
> Dernière mise à jour du document : 2026-11-14.

---

## ⚠️ Sécurité — à lire avant de remplir

1. **Ne collez jamais une clé API dans ce fichier, dans un commit, dans une PR, dans
   une capture d'écran ou dans un ticket.** Ce dépôt est versionné : une clé publiée
   doit être considérée comme compromise et révoquée.
2. Ce document ne contient que des **noms de variables d'environnement**. Les valeurs
   réelles se déposent dans les secrets serveur :
   - **Supabase Studio** → *Edge Functions* → *Secrets* (recommandé), ou
     `supabase secrets set NOM=valeur --project-ref <ref>` ;
   - ou le **gestionnaire de secrets** de votre choix (1Password, Vault, Doppler…)
     avec injection au déploiement.
3. Aucune variable préfixée `VITE_` ne doit contenir de secret : tout ce qui commence
   par `VITE_` est **public** dans le bundle navigateur.
4. Le code ne lit jamais une clé côté navigateur : les clés restent dans les Edge
   Functions (`supabase/functions/vyora-ai`, `supabase/functions/_shared/ai-core/`).
5. Pour transmettre une information sensible, utilisez le canal privé convenu — jamais
   le dépôt. Les éléments nécessaires à l'intégration (URL de base, identifiants de
   modèles, tarifs, quotas) **ne sont pas secrets** et peuvent figurer ici.

### Convention de nommage des variables

| Élément | Convention | Exemple |
|---|---|---|
| Clé API | `BUSINESS_GROW_<FOURNISSEUR>_API_KEY` | `BUSINESS_GROW_MISTRAL_API_KEY` |
| Modèle par défaut | `BUSINESS_GROW_<FOURNISSEUR>_MODEL` | `BUSINESS_GROW_MISTRAL_MODEL` |
| Identifiant de compte (si requis) | `BUSINESS_GROW_<FOURNISSEUR>_ACCOUNT_ID` | `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID` |
| Jeton OAuth (si requis) | `BUSINESS_GROW_<FOURNISSEUR>_AUTH_TOKEN` | `BUSINESS_GROW_CLOUDFLARE_AUTH_TOKEN` |
| Ordre de secours | `BUSINESS_GROW_PROVIDER_ORDER` | `groq,gemini,deepseek` |

Les alias historiques (`GROQ_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`MISTRAL_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`) restent acceptés en repli :
ils ne servent qu'à la compatibilité, la convention `BUSINESS_GROW_*` prime.

### Où déposer la clé, concrètement

```
Supabase Dashboard → Project (xbuuhfwobrafcbgtdgjx) → Edge Functions → Secrets
  BUSINESS_GROW_<FOURNISSEUR>_API_KEY = <valeur>      (jamais dans Git)
```

Après ajout d'une clé : **le fournisseur reste inactif** tant que son modèle n'a pas
passé une **sonde API réelle** (voir § « Cycle de vérification »). C'est volontaire :
aucun modèle non testé n'est servi à un utilisateur.

---

## 1. Cycle de vérification (commun à tous les fournisseurs)

| Étape | Où | Effet |
|---|---|---|
| 1. Clé déposée en secret | Supabase Secrets | `configured` côté moteur (clé présente) |
| 2. Sonde réelle (liste des modèles / appel minimal) | `vyora-ai` action `health` ou admin *Contrôle IA* | écrit `ai_provider_health_checks` |
| 3. Modèle marqué `verified` | Registre (`saas_business.ai_models.verification_status`) | devient routable |
| 4. Activation du routage | `ai_routing_rules` | le routeur peut le choisir |
| 5. Budget / plafond | Admin *Contrôle IA* | bloque avant dépassement |

Tant que l'étape 2 n'a pas réussi, le fournisseur apparaît **« Non vérifié »** dans
l'interface et n'est jamais sélectionné par le routeur.

---

## 2. Google Gemini

**Statut VYORA :** intégration **existante et vérifiée en santé** (modèle
`gemini-2.5-flash` en production au 2026-11-12). Protocole natif (≠ OpenAI).

| Champ | Valeur |
|---|---|
| Nom du fournisseur | Google Gemini (Google AI Studio / Generative Language API) |
| Site officiel | `https://ai.google.dev` |
| Documentation API | à renseigner (URL exacte consultée) |
| Méthode d'authentification | Clé API (en-tête `x-goog-api-key` ou paramètre de requête) |
| **Variable d'environnement** | `BUSINESS_GROW_GEMINI_API_KEY` (alias `GEMINI_API_KEY`) |
| URL de base de l'API | `https://generativelanguage.googleapis.com/v1beta/` |
| Endpoints utilisés par VYORA | `POST models/{model}:generateContent`, `GET models` |
| Modèles disponibles | à renseigner (liste officielle) |
| Identifiants exacts des modèles | à renseigner — catalogue VYORA actuel : `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, `gemini-3-flash-preview`, `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-4-argon` |
| Capacités (texte/image/vidéo/audio/raisonnement) | à renseigner par modèle |
| Limites de requêtes et quotas | à renseigner (RPM/TPM, quotas journaliers du free tier) |
| Tarification (entrée/sortie par 1M tokens) | à renseigner — liens officiels de tarification |
| Région / contraintes géographiques | à renseigner (disponibilité par pays, résidence des données) |
| Informations complémentaires | taille de contexte, formats d'image acceptés, mode JSON structuré, function calling |

---

## 3. Groq

**Statut VYORA :** intégration **existante et vérifiée en santé**
(`openai/gpt-oss-120b` en production au 2026-11-12). Protocole OpenAI-compatible.

| Champ | Valeur |
|---|---|
| Nom du fournisseur | Groq (GroqCloud) |
| Site officiel | `https://groq.com` |
| Documentation API | `https://console.groq.com/docs` (à confirmer) |
| Méthode d'authentification | Clé API — en-tête `Authorization: Bearer <clé>` |
| **Variable d'environnement** | `BUSINESS_GROW_GROQ_API_KEY` (alias `GROQ_API_KEY`) |
| URL de base de l'API | `https://api.groq.com/openai/v1/` |
| Endpoints utilisés par VYORA | `POST chat/completions`, `GET models` |
| Modèles disponibles | à renseigner |
| Identifiants exacts des modèles | à renseigner — catalogue VYORA actuel : `openai-gpt-oss-120b`, `openai-gpt-oss-20b`, `qwen-qwen3.8-27b`, `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen-3-32b` |
| Capacités | texte, raisonnement, outils (à confirmer par modèle) |
| Limites de requêtes et quotas | à renseigner (RPM/TPM par modèle) |
| Tarification | à renseigner — plusieurs références sont « Enterprise / Contact Sales » : prix public indisponible |
| Région / contraintes | à renseigner |
| Informations complémentaires | certains modèles sont en *preview* ; latence très faible (accélération matérielle) |

---

## 4. Mistral AI

**Statut VYORA :** adaptateur **prêt**, fournisseur **non vérifié** (aucune clé).

| Champ | Valeur |
|---|---|
| Nom du fournisseur | Mistral AI |
| Site officiel | `https://mistral.ai` |
| Documentation API | `https://docs.mistral.ai` (à confirmer) |
| Méthode d'authentification | Clé API — `Authorization: Bearer <clé>` |
| **Variable d'environnement** | `BUSINESS_GROW_MISTRAL_API_KEY` (alias `MISTRAL_API_KEY`) |
| URL de base de l'API | `https://api.mistral.ai/v1/` |
| Endpoints utilisés par VYORA | `POST chat/completions`, `GET models` |
| Modèles disponibles | à renseigner |
| Identifiants exacts des modèles | à renseigner — catalogue VYORA actuel : `mistral-large-latest`, `mistral-small-latest`, `open-mistral-nemo` |
| Capacités | texte, documents, outils ; embeddings possibles (à confirmer) |
| Limites de requêtes et quotas | à renseigner |
| Tarification | **non publiée sur les pages consultées le 2026-11-13** → à confirmer sur la console avant activation |
| Région / contraintes | à renseigner (offre UE, résidence des données) |
| Informations complémentaires | — |

---

## 5. DeepSeek

**Statut VYORA :** adaptateur **prêt**, fournisseur **non vérifié** (aucune clé).

| Champ | Valeur |
|---|---|
| Nom du fournisseur | DeepSeek |
| Site officiel | `https://www.deepseek.com` |
| Documentation API | `https://api-docs.deepseek.com` (à confirmer) |
| Méthode d'authentification | Clé API — `Authorization: Bearer <clé>` |
| **Variable d'environnement** | `BUSINESS_GROW_DEEPSEEK_API_KEY` (alias `DEEPSEEK_API_KEY`) |
| URL de base de l'API | `https://api.deepseek.com/` |
| Endpoints utilisés par VYORA | `POST chat/completions`, `GET models` |
| Modèles disponibles | à renseigner |
| Identifiants exacts des modèles | à renseigner — catalogue VYORA actuel : `deepseek-chat` (legacy), `deepseek-flash`, `deepseek-v4-pro` |
| Capacités | texte, raisonnement, documents, outils (à confirmer) |
| Limites de requêtes et quotas | à renseigner |
| Tarification | à renseigner — VYORA distingue **prix pic** et **prix creux** (heures creuses) et le **prix cache hit** |
| Région / contraintes | à renseigner |
| Informations complémentaires | fenêtre de contexte annoncée très large : à confirmer par la documentation officielle |

---

## 6. OpenRouter (agrégateur)

**Statut VYORA :** adaptateur **prêt**, fournisseur **non vérifié** (aucune clé).
Marqué **agrégateur** dans le registre : jamais compté deux fois avec un accès direct.

| Champ | Valeur |
|---|---|
| Nom du fournisseur | OpenRouter |
| Site officiel | `https://openrouter.ai` |
| Documentation API | `https://openrouter.ai/docs` (à confirmer) |
| Méthode d'authentification | Clé API — `Authorization: Bearer <clé>` + en-têtes `HTTP-Referer` et `X-Title` (attribution) |
| **Variable d'environnement** | `BUSINESS_GROW_OPENROUTER_API_KEY` (alias `OPENROUTER_API_KEY`) |
| URL de base de l'API | `https://openrouter.ai/api/v1/` |
| Endpoints utilisés par VYORA | `POST chat/completions`, `GET models` |
| Modèles disponibles | **catalogue vivant** : resynchronisé via `GET /api/v1/models` |
| Identifiants exacts des modèles | à renseigner — exemples déjà au registre : `ernie-5.5-flash-free`, `ling-3.2-flash-free`, `gemini-4-hydrogen` |
| Capacités | dépend du modèle sous-jacent (texte, image, raisonnement…) |
| Limites de requêtes et quotas | à renseigner — les modèles « free » sont **quotés**, jamais illimités |
| Tarification | à renseigner — prix par modèle exposés par `/models` |
| Région / contraintes | à renseigner |
| Informations complémentaires | agrégateur : le coût réel dépend du fournisseur sous-jacent ; anti-double-routage actif |

---

## 7. Cloudflare Workers AI

**Statut VYORA :** adaptateur **prêt**, fournisseur **non vérifié** (aucune clé).
URL **par compte** : l'identifiant de compte est obligatoire en plus du jeton.

| Champ | Valeur |
|---|---|
| Nom du fournisseur | Cloudflare Workers AI |
| Site officiel | `https://www.cloudflare.com/products/workers-ai/` |
| Documentation API | `https://developers.cloudflare.com/workers-ai/` (à confirmer) |
| Méthode d'authentification | Jeton API (`Authorization: Bearer <jeton>`) **+ identifiant de compte** dans l'URL |
| **Variables d'environnement** | `BUSINESS_GROW_CLOUDFLARE_API_TOKEN` et `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID` (+ `BUSINESS_GROW_CLOUDFLARE_MODEL` optionnel) |
| URL de base de l'API | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/` |
| Endpoints utilisés par VYORA | `POST v1/chat`, `GET models` |
| Modèles disponibles | à renseigner |
| Identifiants exacts des modèles | à renseigner — exemples au registre : `qwen3.8-27b-cf`, `embeddinggemma-2-cf` |
| Capacités | texte, embeddings (à confirmer par modèle) |
| Limites de requêtes et quotas | à renseigner — **forfait gratuit journalier limité** (jamais illimité) |
| Tarification | à renseigner (neurons / unités de calcul) |
| Région / contraintes | à renseigner (répartition géographique, pays couverts) |
| Informations complémentaires | l'identifiant de compte n'est pas un secret en soi, mais reste traité comme une donnée serveur |

---

## 8. xAI (Grok)

**Statut VYORA :** adaptateur **prêt**, fournisseur **non vérifié** (aucune clé).

| Champ | Valeur |
|---|---|
| Nom du fournisseur | xAI — Grok |
| Site officiel | `https://x.ai` |
| Documentation API | `https://docs.x.ai` (à confirmer) |
| Méthode d'authentification | Clé API — `Authorization: Bearer <clé>` |
| **Variable d'environnement** | `BUSINESS_GROW_GROK_API_KEY` (alias `XAI_API_KEY`) |
| URL de base de l'API | `https://api.x.ai/v1/` |
| Endpoints utilisés par VYORA | `POST chat/completions`, `GET models` |
| Modèles disponibles | à renseigner |
| Identifiants exacts des modèles | à renseigner — catalogue VYORA actuel : `grok-4.7`, `grok-4.3`, `grok-4.20-0309-reasoning` |
| Capacités | texte, raisonnement, images, outils (à confirmer) |
| Limites de requêtes et quotas | à renseigner |
| Tarification | à renseigner — VYORA applique un tarif dégressif au-delà d'un seuil de prompt (à confirmer) |
| Région / contraintes | à renseigner |
| Informations complémentaires | — |

---

## 9. Fournisseurs supplémentaires (à compléter librement)

Dupliquez ce bloc pour chaque nouveau fournisseur :

```markdown
## N. <Nom du fournisseur>

**Statut VYORA :** à intégrer — aucune clé, aucun modèle vérifié.

| Champ | Valeur |
|---|---|
| Nom du fournisseur | |
| Site officiel | |
| Documentation API | |
| Méthode d'authentification | (type de clé / OAuth / signature) |
| Variable(s) d'environnement | `BUSINESS_GROW_<X>_API_KEY` |
| URL de base de l'API | |
| Endpoints (chat, liste de modèles, embeddings…) | |
| Modèles disponibles | |
| Identifiants exacts des modèles | |
| Capacités par modèle | texte / image / vidéo / audio / raisonnement / outils / JSON |
| Limites de requêtes et quotas | RPM, TPM, RPD, taille de contexte |
| Tarification | entrée / sortie par 1M tokens, coûts annexes |
| Région / contraintes géographiques | |
| Informations complémentaires | prérequis, particularités, limites connues |
```

---

## 10. Récapitulatif à renseigner en priorité

| Fournisseur | Clé déposée ? | Modèle cible | Vérifié par sonde ? | Routage actif ? |
|---|---|---|---|---|
| Google Gemini | oui (prod) | `gemini-2.5-flash` | oui | oui |
| Groq | oui (prod) | `openai/gpt-oss-120b` | oui | oui |
| Mistral AI | non | à renseigner | non | non |
| DeepSeek | non | à renseigner | non | non |
| OpenRouter | non | à renseigner | non | non |
| Cloudflare Workers AI | non | à renseigner | non | non |
| xAI (Grok) | non | à renseigner | non | non |

> **Rappel :** une clé déposée ne suffit pas. Sans sonde réussie, le fournisseur
> reste listé « Non vérifié » et n'est jamais utilisé par le routeur.
