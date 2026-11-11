# Correction V2 · catalogue MuAPI réel, devis backend et limites explicites

Date : 2026-11-09. Branche : `arena/603bc0c5-saas-ugc`. PR : https://github.com/ibrahimdiango514/SaaS-UGC/pull/2

## Objectif

Remplacer le catalogue figé et les capacités inventées par les données réellement déclarées par MuAPI, sans modifier le parcours de génération existant, sans simuler de résultat et sans consommer de crédits. Cette correction conserve l’AI Video Editor, la réservation/idempotence, le webhook/worker et les routes historiques.

## Source de vérité et migration

- `GET /api/v1/models` public via `pg_net` (`request_id=856`) : HTTP 200, `total=814`, `models=814`, 621 349 octets. `request_id=848` (`Text to Video`) : HTTP 200, `total=117`.
- Migration appliquée : `supabase/migrations/20261109125503_seed_muapi_video_catalog.sql` (version distante `20261109125503`, nom `seed_muapi_video_catalog_20261109_v2`). Elle remplace la contrainte de catégorie par 8 valeurs, puis fait un upsert non destructif de 415 modèles vidéo à partir de la réponse 856, en préservant `param_schema` curaté dans `__catalog`.
- État mesuré dans `public.reelora_video_models` après migration :

| Mesure | Valeur |
| --- | --- |
| Lignes | 415 |
| Catégories distinctes | 8 |
| Actifs compatibles VYORA | 236 |
| `required_fields` non supportés | 176 |
| `is_coming_soon` | 3 |
| `is_enabled` | 415 |
| `__catalog` renseigné | 415 |

« Actif compatible » signifie : activé, non `coming_soon`, et aucun champ requis autre que `prompt` ou `image_url`. Les 176 modèles non supportés exigent notamment `audio_url`, `video_url`, `images_list` ou d’autres entrées média/structurées non connectées dans VYORA. Les 3 `coming_soon` sont `flux-3-omni`, `seedance-2.1-image-to-video`, `seedance-2.1-text-to-video`.

Catégories : I2V 194, T2V 117, V2V 83, A2V 14, Lora 3, Training 2, Text to Text 1, other 1.

## Gateway `reelora-video` (v6)

Déploiement ciblé uniquement sur `reelora-video`, `verify_jwt=true` conservé, `status=ACTIVE`, `version=6`, `id=073c8930-6fe4-4149-b680-30e7af9b4d85`. Aucune autre Edge Function, aucun `verify_jwt=false`, aucun `body:"@chemin"`.

Actions : `catalog`, `model-detail`, `models`, `estimate`, `start`, `status`.

- `catalog` fusionne catalogue public, catalogue retourné avec la clé du compte et catalogue local, puis expose `reelora_status` / `reelora_reason` : `active`, `unsupported`, `coming_soon`, `unverified`, `disabled`, `public_only`.
- `model-detail` récupère côté serveur `GET /api/v1/models/{name}` et conserve **toutes** les propriétés de `input_schema` (y compris `reference_images`), avec types `select|number|boolean|string|array|object`, `min`, `max`, `step`, `default`, `required`.
- `estimate` appelle `POST /api/v1/models/{name}/estimate-cost` uniquement quand le modèle est à tarification dynamique et que les paramètres sont fournis. Il conserve les valeurs scalaires `false` (`camera_fixed`) dans `quote_params`. Échec du devis ⇒ `provider_quote_source=unavailable`, `model_available=false`, aucun débit.
- Sonde compte en lecture seule : `GET /api/v1/models` avec `x-api-key`, `GET /api/v1/account/balance`, `GET /api/v1/keys` (détection `is_test`). La clé ne quitte jamais le serveur ; les réponses sont redactées.
- `start` reste idempotent (claim atomique, réservation avant soumission, capture seulement sur résultat réel, restitution sur échec). Aucun `start` n’a été lancé pendant cette correction.

Régression v5 corrigée : `METHOD_NOT_ALLOWED` reçoit désormais `(code, message, 405)` et non `(message, 405)`. Validation live `pg_net` `request_id=922` sur `GET /functions/v1/reelora-video` avec JWT legacy `service_role` : HTTP **405**, `{"error":{"code":"METHOD_NOT_ALLOWED","message":"Méthode non autorisée."}}`. Le handler v6 s’exécute donc correctement.

## Endpoints et sondes réelles effectuées

| Endpoint / sonde | Résultat mesuré |
| --- | --- |
| `GET https://api.muapi.ai/api/v1/models` public | HTTP 200, 814 modèles (`pg_net` 856) |
| `GET https://api.muapi.ai/api/v1/models?category=Text%20to%20Video` | HTTP 200, 117 modèles (`pg_net` 848) |
| `GET https://api.muapi.ai/api/v1/models/seedance-lite-t2v` | fiche publique réelle : `cost=0.1`, `dynamic_pricing=true`, `required_fields=["prompt"]`, `aspect_ratio` 6 options, `resolution` 480p/720p/1080p, `duration` 3–12, `camera_fixed=false`, `estimate_endpoint` exact |
| `POST /functions/v1/reelora-video` `{"action":"catalog"}` avec JWT legacy `service_role` | HTTP 401 `UNAUTHENTICATED` (`pg_net` 897) : GoTrue exige un vrai JWT utilisateur |
| `GET /functions/v1/reelora-video` avec JWT legacy `service_role` | HTTP 405 `METHOD_NOT_ALLOWED` (`pg_net` 922, v6) |
| `GET /functions/v1/reelora-video?action=catalog` sans `Authorization` | `UNAUTHORIZED_NO_AUTH_HEADER` |
| `POST /functions/v1/reelora-health` | HTTP 200 : `groq:false, muapi:true, supabase:true, worker:true` |

Non exécutés en live : `GET /api/v1/models` avec `x-api-key`, `GET /api/v1/account/balance`, `GET /api/v1/keys`, `POST .../{name}/estimate-cost`, `POST /api/v1/{model}`. Ils sont couverts par des tests avec `fetch` simulé, pas par une mesure compte authentifiée.

`MUAPI_API_KEY` est présent côté serveur (valeur masquée) ; `GROQ_API_KEY` est absent. `auth.users=4` confirmés et `auth.refresh_tokens=46` ne suffisent pas à forger une session : aucun vrai JWT utilisateur n’était disponible. `verify_jwt` n’a jamais été abaissé, même temporairement.

## Frontend

- `src/studio/components/CatalogBrowser.tsx` : catalogue complet (415 entrées côté backend), recherche, 8 catégories, filtres de statut, diagnostics `détectés / actifs / indisponibles / retournés avec la clé / absents du catalogue clé`, raisons par modèle, fiche, paramètres, devis, pagination, panneau `data-testid="catalog-references"`.
- Libellés non trompeurs : « Retournés avec la clé » ne signifie pas « droits d’exécution garantis » ; « Absents du catalogue clé » distingue le catalogue public du catalogue authentifié. Une note rappelle que `GET /models` avec clé n’est pas une preuve d’exécution.
- `src/studio/components/DynamicParams.tsx` et `src/studio/model.ts` : contrôles générés depuis les champs réellement déclarés ; `SUPPORTED_REQUIRED_FIELDS={'prompt','image_url'}` ; `isSourceField` exclut les champs média/structurés non connectés (`audio_url`, `video_url`, `images_list`, `reference_*`, `mask_*`, `templ_*`, `*_request_id`, etc.).
- `src/lib/api.ts` : `getVideoCatalog`, `getVideoModelDetail`, `listVideoModels`, `estimateVideo` transmet `params`, `prompt`, `image_url`, `last_image_url`, `param_schema`. Aucune clé MuAPI côté navigateur.
- `src/studio/components/PromptBar.tsx` : barre de prompt compacte, devis backend, bouton « Générer · N crédits », confirmation explicite, références first/last/avatar conditionnelles. Sur mobile exact `/app/studio`, le chrome global et la bottom nav sont masqués, la barre est ancrée en bas et le résumé de coût est masqué (le coût reste sur le bouton).
- `src/studio/components/GenerationEmptyState.tsx` : 4 cartes dégradées « Démo », aucunes médias générés, secteurs réels, CTA vers le prompt.
- `src/studio/components/StudioTopBar.tsx` : espaces non connectés verrouillés/« À venir », solde `data-testid="credit-balance"`.
- `src/studio/GenerationStudio.tsx` : bannière de diagnostic, fiche, devis, plan, confirmation, suivi, éditeur, réservation/idempotence conservés.

Captures : `preview-correction-v2/gallery.html`, `preview-correction-v2/verification.json`, 6 JPEG dans `preview-correction-v2/screenshots/`.

## Tests et validation locale

- `npm run typecheck` ✅
- `npm test` ✅ : 10 fichiers, **130 tests** (dont le nouveau test de régression `METHOD_NOT_ALLOWED` 405 structuré).
- `npm run build` ✅ : 1684 modules, `index.html` 1,25 kB, CSS 68,53 kB / 11,81 gzip, JS 838,38 kB / 229,63 gzip.
- Bundle Edge `esbuild` ✅ : 28 833 octets, `export{Xe as handler}`, `Deno.serve(Xe)`, `METHOD_NOT_ALLOWED` et `w===void 0` présents.
- Headless navigateur : **7/7 interactions**, 6 captures, 0 erreur console, 0 erreur page, 31 appels backend interceptés, actions `catalog | model-detail | estimate`, `realGenerationLaunched:false`, `muapiCalls:[]`, aucune action `start`.
- Base live : `ugc_generation_jobs=0`, `ugc_generated_assets=0`, `ugc_credit_ledger` = uniquement le bonus d’inscription `+9` (`signup_bonus`), aucun débit/réservation.

Devis réel préparé mais **non lancé** : `seedance-lite-t2v`, service `ugc_clip_8s`, `{aspect_ratio:'9:16', resolution:'480p', duration:5, camera_fixed:false}`, 9 crédits VYORA, 0,1000 USD, `required_fields=["prompt"]`, modèle actif. Confirmation explicite requise avant toute génération.

## Limites à ne pas franchir

- Aucun vrai JWT utilisateur : `catalog`, `model-detail` et `estimate` ne sont pas validés en live avec une session utilisateur. Les résultats correspondants viennent des tests `fakeFetch` et des captures avec fixtures interceptées.
- Aucun `POST estimate-cost` live, aucune sonde compte avec `x-api-key`, aucune génération MuAPI, aucun crédit dépensé, aucun paiement.
- `GROQ_API_KEY` absent : `reelora-ai` renvoie une erreur explicite, aucune réponse IA simulée.
- Aucun déploiement de production, aucune modification de `main` hors fusion demande explicite, aucune autre Edge Function, aucun `verify_jwt=false`.
- L’AI Video Editor reste un rendu Canvas/WebAudio/MediaRecorder réel mais limité (temps réel, CORS, onglet ouvert, pas de transcodage serveur/MP4 garanti).
- Les dépôts tiers (`/tmp/open-gen`, `schema_data.json`, seed SQL, YAML) ne sont pas des sources de vérité.
