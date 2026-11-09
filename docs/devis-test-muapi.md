# Devis — test réel de génération MuAPI

**Statut : PRÉPARÉ, NON LANCÉ.** Ce document affiche le devis **avant** toute génération,
conformément à la règle : modèle, paramètres, coût estimé en crédits et coût fournisseur
doivent être visibles, puis une confirmation explicite est requise. Aucun appel
`POST https://api.muapi.ai/api/v1/{model}` n'a été effectué, aucun crédit n'a été
réservé ou dépensé, aucun job n'a été créé (`ugc_generation_jobs` = 0 au moment du devis).

Date du relevé : 2026-11-08 (UTC). Valeurs lues en **lecture seule** dans
`xbuuhfwobrafcbgtdgjx` (`saas_ugc.ugc_video_models`, `saas_ugc.ugc_service_catalog`).

---

## 1. Modèle proposé

| Champ | Valeur |
| --- | --- |
| `model_id` | `seedance-lite-t2v` |
| Nom affiché | Seedance Lite — Texte → Vidéo |
| Mode | Text to Video |
| Endpoint | `/api/v1/seedance-lite-t2v` |
| Champs requis | `["prompt"]` |
| Champs acceptés | `["prompt", "aspect_ratio", "resolution", "duration", "camera_fixed"]` |
| Disponibilité live | `active=true`, `is_enabled=true`, `is_coming_soon=false` |
| Coût fournisseur | **0,1000 USD** (`cost_currency=USD`) |

Motif du choix : modèle T2V le moins coûteux du catalogue vérifié, sans image de
référence requise — donc le test le plus simple et le moins risqué. Le catalogue
reste dérivé de la table `ugc_video_models` ; `actionModels()` rafraîchit uniquement
les métadonnées depuis `GET /api/v1/models`, sans inventer d'endpoint.

## 2. Paramètres exactement envoyés

Valeurs par défaut issues de `param_schema ∩ input_fields` (aucun paramètre
supplémentaire n'est affiché ni transmis) :

| Paramètre | Valeur | Type / contrainte |
| --- | --- | --- |
| `aspect_ratio` | `9:16` | select `[16:9, 9:16, 1:1, 4:3, 3:4, 9:21]` |
| `resolution` | `480p` | select `[480p, 720p, 1080p]` |
| `duration` | `5` | number, min 5 / max 30 (secondes) |
| `camera_fixed` | `false` | boolean |
| `prompt` | texte saisi par l'utilisateur (20 caractères minimum) | requis |

Exemple de prompt de test (libre, à valider par l'utilisateur) :
> Une créatrice présente un flacon de sérum dans une salle de bain lumineuse, plan
> smartphone légèrement handheld, geste naturel, lumière dorée, style UGC authentique.

`script_text` / `scenes` restent optionnels : Groq n'étant pas configuré, aucun script
n'est généré ni simulé. Le prompt visuel seul est envoyé.

## 3. Coût estimé

| Poste | Valeur | Source |
| --- | --- | --- |
| Service Reelora | `ugc_clip_8s` | `ugc_service_catalog` (actif) |
| **Crédits Reelora réservés** | **9 crédits** | `credits_cost = 9`, règles validées inchangées |
| **Coût fournisseur MuAPI** | **0,1000 USD** | `cost_usd` du modèle |
| Débit définitif | uniquement si `finalize_generation(..., 'succeeded')` | RPC existante |
| Restitution | échec MuAPI, image manquante, annulation, expiration 45 min | `reelora_release_video_quota` |
| Idempotence | 1 `request_key` par opération + claim atomique de soumission | `reelora_start_generation`, `reelora_claim_generation_submission` |

Le solde du compte de test doit être **≥ 9 crédits**. Le devis est affiché dans
l'application par `CostConfirm` (modèle, `model_id`, résumé des paramètres, coût
Reelora, solde, solde après réservation, coût fournisseur) avec une case à cocher
« Je confirme » obligatoire avant tout `start`.

## 4. Conditions préalables au lancement

1. `MUAPI_API_KEY` présent côté serveur — **oui** (sonde `reelora-health` : `muapi:true`).
   ⚠️ Ce booléen prouve seulement la **présence** du secret, pas sa validité auprès de
   MuAPI. Le premier appel réel peut donc échouer ; dans ce cas les 9 crédits sont
   restitués automatiquement et la tâche passe `failed` avec un message lisible.
2. Compte authentifié dans la Preview, avec un projet existant et ≥ 9 crédits.
3. Catalogue chargé (« Catalogue MuAPI vérifié ») et estimation serveur
   (« Estimation serveur vérifiée »).
4. **Confirmation explicite de l'utilisateur après lecture de ce devis.**
5. Aucune clé n'est exposée : `MUAPI_API_KEY` n'est lue que dans les Edge Functions.

## 5. Ce qui sera observé après confirmation

- `POST reelora-video {action:"start"}` → `provider_job_id` (`request_id` MuAPI),
  statut `processing`, coût fournisseur renvoyé par MuAPI.
- Suivi serveur : webhook `?webhook=` + cron `reelora-video-tick` (1 min) →
  `GET /predictions/{id}/result` → état réel, jamais le corps du callback.
- Succès : vidéo stockée dans `ugc-assets` privé, URL signée de prévisualisation,
  téléchargement, entrée dans Mes créations enregistrées, ledger `reserve` → `capture`.
- Échec : `failed` + `error_code`, restitution des 9 crédits, `ugc_job_events` tracé.

## 6. Confirmation requise

> **Aucune génération n'est lancée sans réponse explicite de l'utilisateur.**
> Pour autoriser : répondre « Je confirme le test réel avec `seedance-lite-t2v`,
> 9 crédits, 0,1000 USD, paramètres 9:16 / 480p / 5 s / caméra libre ».
> Sans cette confirmation, l'intégration reste prête mais aucun crédit n'est utilisé.
