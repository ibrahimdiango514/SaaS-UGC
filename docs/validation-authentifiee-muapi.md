# REELORA — Validation authentifiée MuAPI et finalisation du Studio

**Date d'exécution :** 2026-11-09 (horodatages UTC des outils Supabase).
**Branche :** `arena/e22e624f-saas-ugc` (active, déjà basée sur `main` à jour).
**Commit de départ :** `cee9e5aebf2b7cee3ea552b17b4a4deafea112ef` — merge de la PR #2 (`f812b30`), dernière correction V2. `origin/main` et `main` sont au même commit ; aucun commit n'a été ajouté à `main`, aucune PR n'a été créée ou fusionnée pendant cette phase.
**Commit de livraison :** `3b99f98` sur `arena/e22e624f-saas-ugc` (poussé sur cette seule branche, 18 fichiers, `+637/−15`) ; ce rapport et la galerie en font partie.
**Projet Supabase :** `xbuuhfwobrafcbgtdgjx`. `reelora-video` **v6 ACTIVE**, `verify_jwt=true` inchangé (`id=073c8930-6fe4-4149-b680-30e7af9b4d85`).

> Ce rapport distingue strictement trois niveaux : **mesures live** (vrai JWT utilisateur + Edge déployée + MuAPI), **corrections de code validées par tests/fixtures**, et **limites**. Aucune fonctionnalité testée uniquement avec fixtures n'est déclarée validée en live.

---

## 1. Session utilisateur réelle (autorisée, additive, sans crédit)

Méthode retenue par l'utilisateur : un seul compte de test additif, sans privilège ni crédit, utilisé uniquement pour les trois sondes `catalog` / `model-detail` / `estimate`, avec désactivation temporaire du bonus d'inscription puis restauration immédiate (`toggle_bonus`).

| Élément | Valeur |
| --- | --- |
| `user_id` | `57564495-c869-42af-8b45-38df9fbd634b` |
| e-mail | `reelora-probe-c985c0c94d27@example.com` |
| rôle | `authenticated`, `aal1`, JWT ES256, `expires_in=3600`, `exp=1794238671` |
| confirmation | `2026-11-09T14:37:07.210560231Z` |
| `auth.users` | 4 → **5** |
| `saas_ugc.ugc_app_settings.signup_bonus` | `{"credits":9,"enabled":false}` à `14:36:43.688779+00`, restauré `{"credits":9,"enabled":true}` après création |
| wallet du compte | `available_balance=0`, `reserved_balance=0` |
| ledger du compte | 0 ligne, 0 `signup_bonus`, 0 rôle UGC, 0 abonnement UGC |
| effet additif signalé | `saas_immobilier.user_profiles=1` (trigger existant `on_auth_user_created_profile` / `public.handle_new_user_profile`, hors périmètre UGC) |

Identifiants et JWT restent **hors dépôt** dans `/tmp/reelora-test-user.json` et `/tmp/reelora-test-session.json`. Aucun secret MuAPI, anon ou service_role n'a été recopié dans ce rapport ni exposé au frontend.

---

## 2. Diagnostic live : pourquoi `model-detail` échouait avant correction

| `request_id` | Opération | Résultat |
| --- | --- | --- |
| 969 | `POST reelora-video {action:catalog}` avec vrai JWT | **200**, 435 285 octets |
| 970 | `POST reelora-video {action:model-detail, model_id:seedance-lite-t2v}` avec vrai JWT | **404** `MODEL_NOT_FOUND` |
| 974 | `GET /rest/v1/reelora_video_models` avec `service_role` | **403 / 42501** `permission denied for table ugc_video_models` |

Cause : `public.reelora_video_models` est une vue `security_invoker=true` sur `saas_ugc.ugc_video_models`. La migration `20261108000001` avait fait `grant select on all tables in schema saas_ugc to service_role`, mais la table a été créée **plus tard** (`20261108000009`) et n'avait accordé `SELECT` qu'à `anon, authenticated`. L'Edge lisait donc `[]` : `catalog` survivait grâce aux entrées MuAPI live (d'où `param_schema:{}`, `synced_at:null`), tandis que `loadModel()` ne trouvait aucun modèle.

**Correction autorisée** (`ask_user` → `grant_select`) : migration strictement additive `20261109144611_reelora_video_models_service_select.sql` :

```sql
grant select on saas_ugc.ugc_video_models to service_role;
```

Validée avant application par un essai en transaction avec `ROLLBACK` (`has_table_privilege` vrai pendant la transaction, faux après). `service_role` possédait déjà `rolbypassrls=true` et `USAGE` sur le schéma : **aucune politique RLS, aucun rôle utilisateur, aucune donnée, aucune vue, aucune colonne ni aucun privilège existant n'a été modifié**. Après application : `service_select=true`, `rls_policy_count=1`, `catalog_rows=415`.

---

## 3. Résultats des opérations LIVE

Toutes les sondes ci-dessous utilisent le **vrai JWT `authenticated`** via `pg_net` → `POST https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/reelora-video`, avec `verify_jwt=true`. Le secret `MUAPI_API_KEY` n'est utilisé que côté Edge pour les appels MuAPI.

### 3.1 `catalog` — validé en live

`request_id=969` (avant GRANT) puis `980` (après GRANT, 448 904 octets) → **HTTP 200**.

```
source              : muapi_authenticated
account.key_valid   : true
account.key_is_test : false
account.key_configured : true
catalog_status / balance_status / keys_status : 200 / 200 / 200
public_total        : 814
authenticated_total : 814
detected_video      : 415
account_accessible  : 415
public_only         : 0
active              : 236
unavailable         : 179   (unsupported 176 + coming_soon 3)
reasons             : { active: 236, coming_soon: 3, unsupported: 176 }
endpoints           : GET /api/v1/models (public 200), GET /api/v1/models (authentifié 200),
                      GET /api/v1/account/balance (200), GET /api/v1/keys (200)
```

**Nombre de modèles réellement accessibles au compte : 415 références vidéo retournées par le catalogue authentifié**, dont **236 actives et sélectionnables dans Reelora** ; 176 entrées non connectées (champs média/structurés requis), 3 `coming_soon`. Réserve importante, déjà affichée dans l'UI : `GET /models` avec la clé ne prouve pas les **droits d'exécution** par modèle ; ces 415 ne sont pas une preuve que la génération aboutirait pour chacun.

Le tri par coût réel appliqué au catalogue live (`catalogByCost` : mode `text-to-video`, `isModelAvailable`, `required_fields ⊆ {prompt,image_url}`, tri `cost_usd`) donne **104 modèles T2V éligibles** et les trois paliers ci-dessous. Aucun modèle fictif n'a été introduit.

### 3.2 `model-detail` — validé en live

| `request_id` | Modèle | HTTP | Schéma réel obtenu |
| --- | --- | --- | --- |
| 981 | `seedance-lite-t2v` | 200 (1 523 o) | `duration` 3–12 / défaut 5, `resolution` 480p·720p·1080p, `aspect_ratio` 6 options, `camera_fixed:boolean`, `estimate-cost` déclaré |
| 985 | `wan2.2-5b-fast-t2v` | 200 (1 265 o) | `resolution` 480p·580p·720p, `aspect_ratio` 16:9·9:16·1:1, `prompt` requis |
| 986 | `seedance-2.5-spicy-text-to-video` | 200 (2 960 o) | `duration` 4–16 / défaut 5, `resolution` 480p·720p·1080p·4k, `aspect_ratio` 7 options, `generate_audio` (défaut true), `camera_fixed`, `high_bitrate`, `draft` |
| 987 | `seedance-2.5-spicy-text-to-video-4k` | 200 (1 970 o) | `duration` 4–30 / défaut 5, `aspect_ratio` 8 options, `high_bitrate`, `seed` |

`source=muapi_model_detail` ; aucun `account_access` n'est surécrit (le catalogue authentifié reste la seule source de vérité pour l'accès au compte). Aucun secret ni solde n'apparaît dans les réponses. Les champs média/structurés (`reference_images`, `draft_request_id`, …) restent exposés mais ne deviennent jamais des contrôles scalaires inventés.

### 3.3 `estimate` — devis exact réel, sans génération

Trois `POST` Edge `action:estimate` avec le vrai JWT, `param_schema` issu des fiches live ci-dessus, et un prompt de 117 caractères. L'Edge a appelé **uniquement** `POST /api/v1/models/{name}/estimate-cost` côté MuAPI (jamais `POST /api/v1/{model}`).

| Palier | Modèle (catalogue live) | Tarif catalogue | **Devis exact MuAPI** | Crédits Reelora | Service | `request_id` | `quote_source` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rapide | `wan2.2-5b-fast-t2v` | 0,016 USD | **0,02 USD** | 9 | `ugc_clip_8s` | 990 | `estimate_cost` |
| Standard | `seedance-2.5-spicy-text-to-video` | 0,600 USD | **1,87 USD** | 16 | `ugc_clip_15s` | 991 | `estimate_cost` |
| Premium | `seedance-2.5-spicy-text-to-video-4k` | 9,350 USD | **9,35 USD** | 36 | `ugc_ad_4clips` | 992 | `estimate_cost` |

Les trois réponses sont `HTTP 200`, `model_available=true`, `model_status=active`, `provider_quote_error=null`, `provider_cost_currency=USD`. Paramètres exactement transmis et renvoyés dans `quote_params` :

- Rapide : `prompt`, `aspect_ratio:'9:16'`, `resolution:'480p'`.
- Standard : `prompt`, `duration:5`, `resolution:'720p'`, `aspect_ratio:'9:16'`, `camera_fixed:false`, `high_bitrate:false`, `generate_audio:true`.
- Premium : `prompt`, `duration:5`, `aspect_ratio:'9:16'`, `high_bitrate:false`.

**Tarification dynamique confirmée** : 0,016 → 0,02 et 0,600 → 1,87 USD diffèrent du tarif catalogue ; 9,350 → 9,35 est identique. Le devis exact remplace donc bien le tarif catalogue quand `estimate-cost` répond.

**Comparaison USD / crédits et arrondis** : aucune conversion USD ↔ crédits n'est effectuée dans le frontend. Les crédits proviennent de `ugc_service_catalog` (9 / 16 / 36) et restent indépendants du coût fournisseur ; l'affichage utilise seulement `toFixed(3)` (0,020 / 1,870 / 9,350 USD). Aucun arrondi de facturation n'a eu lieu puisqu'aucune réservation ni capture n'a été déclenchée. Les crédits UGC ne sont pas mélangés à l'abonnement Business Growth Workspace.

### 3.4 Modèles « devis fournisseur à confirmer »

**Aucun des trois paliers mesurés en live n'est tombé en « à confirmer »** : les trois `estimate-cost` ont répondu un coût exploitable. Les 179 entrées `unavailable` du diagnostic catalogue sont des modèles **non sélectionnables** (176 entrées non connectées + 3 `coming_soon`), pas des échecs de devis. Le comportement d'échec `estimate-cost` n'a donc **pas** été mesuré en live : il est couvert par les tests et les captures avec fixtures (§5-§6). C'est une limite explicite, pas une validation live.

---

## 4. Correction du défaut « ne jamais inventer un prix »

Audit : `actionEstimate` initialisait `providerCostUsd = catalogCost`. Si `estimate-cost` échouait (secret absent, endpoint absent, prompt requis manquant, HTTP erreur, coût inexploitable), il passait bien `quoteSource='unavailable'` / `model_available=false` / `model_status='unverified'`, **mais laissait le prix catalogue** dans `provider_cost_usd`. Le Studio affichait alors `Number(x ?? 0).toFixed(3)` → `0.000 USD` ou le tarif catalogue avec l'étiquette « catalogue MuAPI », ce qui contrevenait à « ne jamais inventer un prix si le devis échoue ».

Corrections apportées (source uniquement, **sans redéploiement** — voir limites) :

- `supabase/functions/reelora-video/index.ts` : `if (quoteSource === "unavailable") providerCostUsd = null;` juste avant la réponse. `provider_quote_error` reste explicite et `model_available=false` bloque la génération.
- `src/studio/model.ts` : ajout de `QUOTE_TO_CONFIRM`, `isExactProviderQuote`, `providerQuoteCostLabel`, `providerQuoteOriginLabel`. Un devis `unavailable` ou un coût `null` affiche **« devis fournisseur à confirmer »** ; un devis `estimate_cost` affiche le montant à 3 décimales ; un tarif `catalog` reste affiché mais est étiqueté « tarif catalogue MuAPI · devis exact non disponible » (il n'est jamais présenté comme un devis exact).
- `src/studio/GenerationStudio.tsx`, `src/studio/components/PromptBar.tsx`, `CatalogBrowser.tsx`, `CostConfirm.tsx`, `src/pages/Studio.tsx` : suppression de tous les replis `?? 0).toFixed(3)` sur le coût fournisseur, usage des nouveaux libellés, mise en ambre quand le devis est indisponible.
- `src/studio/components/PromptBar.tsx` : la ligne « crédits UGC + fournisseur » est de nouveau visible sur mobile (390×844) sans chevauchement ; le solde détaillé reste réservé au desktop, le solde global restant affiché en haut de barre.

Règles conservées : réservation des crédits **avant** génération, capture uniquement sur succès, remboursement sur échec/annulation/expiration, idempotence, absence de double facturation, écran `CostConfirm` obligatoire (checkbox + bouton désactivé tant que le devis n'est pas exact), secret exclusivement serveur, `verify_jwt=true`.

---

## 5. Tests obligatoires

`npm run typecheck` ✅ · `npm test` ✅ · `npm run build` ✅

```
Test Files  10 passed (10)
Tests       142 passed (142)     (130 avant cette phase)
build       1684 modules — dist/assets/index-riu5COKu.js 838,89 kB / 229,77 kB gzip
```

`tests/muapi.test.ts` passe de 34 à **46 tests** : 9 cas demandés ajoutés + 3 tests de libellé UI + 1 assertion renforcée sur l'échec fournisseur (`provider_cost_usd === null`).

| # | Cas | Couverture |
| --- | --- | --- |
| 1 | Catalogue authentifié | JWT validé par GoTrue, `/models` avec `x-api-key`, `source=muapi_authenticated`, `account/active`, aucune génération |
| 2 | Fiche modèle | `GET /api/v1/models/{name}` côté serveur, schéma réel, pas de secret, aucun `account_access` surécrit |
| 3 | Devis statique | `quote_source='catalog'`, tarif catalogue explicite, **0** POST `estimate-cost`, aucun débit |
| 4 | Devis dynamique | 1 POST `estimate-cost` avec `prompt` + paramètres exacts, coût fournisseur remplaçant le catalogue, aucun `start` |
| 5 | Modèle inaccessible | `public_only` → `reelora_status='unverified'` ; `coming_soon` → `model_available=false`, aucun appel de génération |
| 6 | Erreur fournisseur | HTTP 503 → `unavailable`, **`provider_cost_usd=null`**, libellé « devis fournisseur à confirmer », génération bloquée |
| 7 | Paramètres invalides | option `select` inconnue écartée, nombre borné au `max`, champs source (`audio_url`, `reference_images`) jamais transmis |
| 8 | Absence de génération pendant devis | `catalog` + `model-detail` + `estimate` : 0 soumission MuAPI, 0 claim, 0 `set_job_processing`, 0 écriture Storage |
| 9 | Absence de débit | 0 RPC de réservation/consommation/capture/remboursement, 0 écriture ledger/wallet, `credits_cost` inchangé |

Ces tests sont des **fixtures** (fakeFetch) : ils valident le code, pas le réseau MuAPI. Les mesures live sont celles du §3.

---

## 6. Vérifications visuelles (desktop / mobile, fixtures navigateur)

Livrables : `preview-validation-muapi/gallery.html`, `preview-validation-muapi/verification.json`, 6 JPEG dans `preview-validation-muapi/screenshots/`.

```
interactions      : 6/6 passées
consoleErrors     : 0
pageErrors        : 0
backendCalls      : 79 (tous interceptés localement)
edgeActions       : catalog | model-detail | estimate
startActions      : 0
muapiCalls        : []
realGenerationLaunched : false
jobsCreated       : 0
creditsSpent      : 0
viewports         : 1440×1000 et 390×844
```

| Capture | Vérification |
| --- | --- |
| `01-studio-desktop-devis-exact.jpg` | Devis serveur : 16 crédits UGC, **1,870 USD**, origine `estimate-cost MuAPI`, catalogue 5 modèles / 3 actifs / 2 indisponibles |
| `02-confirmation-desktop.jpg` | `CostConfirm` obligatoire : modèle, paramètres, 16 crédits, 1,870 USD, solde après réservation 26, checkbox non cochée ⇒ bouton désactivé, aucun `start` |
| `03-modele-parametres-desktop.jpg` | Fiche `seedance-2.5-spicy-text-to-video`, contraintes réelles (durée, résolution, format, audio), endpoint `estimate-cost` |
| `04-studio-mobile-devis-exact.jpg` | 390×844 : barre de prompt, **16 crédits UGC + Fournisseur 1,870 USD** visibles, aucun chevauchement |
| `05-studio-desktop-devis-a-confirmer.jpg` | Échec `estimate-cost` : **« devis fournisseur à confirmer »** en ambre, aucun `0.000 USD`, bouton de génération désactivé |
| `06-studio-mobile-devis-a-confirmer.jpg` | 390×844 : même libellé lisible, bannière « Devis backend indisponible », génération bloquée |

Ces captures sont des **fixtures navigateur** : elles ne constituent pas une validation MuAPI live.

---

## 7. Fichiers modifiés / ajoutés

| Fichier | Objet |
| --- | --- |
| `supabase/migrations/20261109144611_reelora_video_models_service_select.sql` | **Ajout** — GRANT SELECT additif, justifié et validé avant application |
| `supabase/functions/reelora-video/index.ts` | `provider_cost_usd=null` quand `quote_source='unavailable'` |
| `src/studio/model.ts` | Nouveaux libellés de devis (`QUOTE_TO_CONFIRM`, `providerQuoteCostLabel`, `providerQuoteOriginLabel`, `isExactProviderQuote`) |
| `src/studio/GenerationStudio.tsx` | Panneau « Devis serveur » : coût et origine non inventés |
| `src/studio/components/PromptBar.tsx` | Libellé serveur, plus de repli à zéro, résumé crédits + USD visible sur mobile |
| `src/studio/components/CatalogBrowser.tsx` | Devis et origine avec libellé « à confirmer » |
| `src/studio/components/CostConfirm.tsx` | Coût fournisseur avec libellé « à confirmer » |
| `src/pages/Studio.tsx` | Cohérence du parcours classique (aucun `0.000 USD`) |
| `tests/muapi.test.ts` | 12 tests ajoutés + 1 assertion renforcée |
| `docs/validation-authentifiee-muapi.md` | Ce rapport |
| `preview-validation-muapi/*` | 6 captures, `verification.json`, `gallery.html` |

`dist/` reste ignoré par Git. Aucun fichier de `/tmp` (identifiants, JWT, SQL de sonde) n'est versionné.

---

## 8. Limites et non-fait

- **Aucun redéploiement** de `reelora-video` n'a été effectué : la phase interdit le déploiement production. Les sondes live ont donc été mesurées contre la **v6 déjà déployée (pré-correctif)**. Le chemin de succès `estimate-cost` est intact en v6 ; en revanche le nouveau comportement `provider_cost_usd=null` / « devis fournisseur à confirmer » est validé **uniquement** par les tests et les captures avec fixtures, **pas en live**. Il faudra une autorisation explicite de redéploiement pour le valider en live.
- L'échec `estimate-cost`, le devis statique, le modèle inaccessible et les paramètres invalides n'ont **pas** été provoqués en live (aucun modèle `public_only` dans le catalogue authentifié, les trois paliers sont dynamiques et ont tous répondu). Ils sont couverts par fixtures uniquement.
- `GET /models` avec clé valide ne prouve pas les droits d'exécution par modèle ; « 415 accessibles au compte » signifie « 415 références retournées par le catalogue authentifié ».
- `GROQ_API_KEY` reste absent : `GROQ_NOT_CONFIGURED`, aucune IA simulée, plan local déterministe uniquement.
- Aucune autre Edge Function, aucun secret, aucun rôle, aucune politique RLS, aucune donnée, aucun schéma destructif, aucun compte existant, aucune branche, aucun `main`, aucune PR, aucun merge et aucun environnement de production n'ont été modifiés.
- Le JWT de test expire à `exp=1794238671` ; toutes les sondes ont été exécutées avant cette échéance. `verify_jwt=true` est resté actif du début à la fin.
- Le compte de test subsiste (`auth.users=5`) avec `wallet=0`, `ledger=0`, `signup_bonus` restauré à `enabled=true`, et un profil additif `saas_immobilier.user_profiles=1` créé par le trigger existant.

---

## 9. Confirmation finale

État vérifié après toutes les opérations : `ugc_generation_jobs=0`, `ugc_generated_assets=0`, `ugc_credit_ledger=1` (ligne historique `signup_bonus:+9` d'un autre utilisateur, antérieure à cette phase), wallet du compte de test `0/0`, `startActions=0`, `muapiCalls=[]` dans les captures, aucun `POST /api/v1/{model}` de génération.

> **Aucune génération vidéo n'a été lancée et aucune dépense, aucun débit, aucune réservation ni aucun crédit n'a été consommé pendant cette phase.**
