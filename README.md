# Reelora — Studio UGC propulsé par l'IA (MuAPI)

SaaS francophone de création de contenus UGC : scripts publicitaires générés par **Groq**, génération vidéo réelle par **MuAPI** (fournisseur vidéo principal), bibliothèque privée, crédits/quotas et administration. Ce dépôt contient l'intégralité des sources (frontend, migrations SQL, Edge Functions, configuration, tests). Rien n'est une maquette : chaque écran est relié à Supabase et aux services d'IA côté serveur.

> **Important** — `MUAPI_API_KEY` et `GROQ_API_KEY` ne sont pas inclus. Sans eux, Reelora affiche une erreur explicite (`MUAPI_NOT_CONFIGURED`, `GROQ_NOT_CONFIGURED`), ne produit **aucun faux résultat** et restitue les crédits réservés. **Aucune génération vidéo réelle n'a été testée** : aucun secret MuAPI n'était disponible. Tous les tests automatisés utilisent des mocks. Voir [§7](#7-configuration-requise-intervention-utilisateur).

---

## 1. Fonctionnalités

| Domaine | Implémentation |
| --- | --- |
| Pages publiques | Accueil avec formules **chargées depuis la base**, fonctionnalités, workflow, FAQ, confidentialité, conditions, 404 |
| Authentification | Inscription, connexion, mot de passe oublié, callback Supabase, réinitialisation, déconnexion, session persistante |
| Tableau de bord | Statistiques réelles, quotas, dernières générations, état des intégrations Groq / MuAPI / worker |
| Projets | Création, recherche, filtre par statut, fiche détaillée, édition du brief, scripts, scènes, générations, suppression |
| **UGC Studio MuAPI** | 5 étapes : projet/produit/objectif → script Groq → scènes & prompts → **catalogue de modèles MuAPI + paramètres vérifiés** → coût estimé, confirmation explicite, progression, erreur lisible, **lecteur vidéo de prévisualisation**, téléchargement, vidéos précédentes et reprise d'un suivi |
| Avatars | CRUD, **image de référence** uploadée dans `ugc-assets` pour les modèles MuAPI image → vidéo, avatar par défaut |
| Scripts IA | Groq (accroche, script, CTA, angle, allégations à éviter, storyboard), accroches alternatives, enregistrement en base, approbation |
| Prompts | CRUD de modèles, variables `{{...}}`, aperçu, favoris, modèles système, amélioration par Groq |
| Réglages vidéo | CRUD de préréglages alignés sur MuAPI (modèle, format, résolution, durée) |
| Bibliothèque | Vidéos réellement produites, URL signées (1 h), lecteur, téléchargement, suppression |
| Historique | Toutes les tâches, modèle MuAPI, `request_id`, événements de production, filtres, annulation, **journal complet du ledger de crédits**, lien « Reprendre le suivi » |
| Abonnement | 4 formules issues de la base, quotas mensuels, demande de changement, recharges, codes promotionnels |
| Administration | Vue d'ensemble, utilisateurs/rôles, suspension, formule, ajustement de crédits, recharges, catalogue, paramètres, audit |
| Transverse | Interface 100 % française, mobile-first, responsive, états de chargement/erreur/vide, notifications, error boundary |

## 1bis. Nouvelle expérience « Reelora Video Studio »

L'entrée principale `/app/studio` est une refonte originale, premium et mobile-first : identité Reelora (aurora violet/cyan, grain discret, animations `fadeUp`), grande prévisualisation centrale, navigation modulaire horizontale, barre d'action collante et hiérarchie claire. Elle s'inspire fonctionnellement de la section vidéo MuAPI sans en copier l'interface.

| Espace | Route | État |
| --- | --- | --- |
| **Video Studio** | `/app/studio` | **Opérationnel** : catalogue MuAPI vérifié, modes, prompt, crédits, suivi et résultat. L'activation d'une génération réelle reste conditionnée au secret serveur `MUAPI_API_KEY`. |
| **My Generations** | `/app/historique`, `/app/studio/generations` | **Opérationnel** : tâches, modèle, paramètres, description, coût, date, événements, ledger, reprise du suivi et relance avec paramètres similaires. |
| **My Projects** | `/app/projets`, `/app/studio/projects` | **Opérationnel** : projets, scripts, scènes et rattachement des créations. |
| **Mes créations enregistrées** | `/app/bibliotheque`, `/app/studio/saved` | **Opérationnel** : lecture, téléchargement, modèle, paramètres, coût, date, rattachement à un projet, relance. Fichiers dans `ugc-assets` privé. |
| Image Studio, Avatar Studio, Video to Video, Image Generation, Audio Studio, AI Clipping, Lip Sync, Vibe Motion, Body Swap, Cinema Studio, Marketing Studio, Workflows, Agents, Storyboarding | `/app/studio/espace/:section` | **Préparés, non opérationnels** : routes et architecture modulaire en place, aucun fournisseur, aucun bouton de génération, aucun résultat simulé. |
| Parcours classique 5 étapes | `/app/studio/avance` | Conservé pour ne supprimer aucune fonctionnalité validée. |

Le Video Studio génère dynamiquement ses paramètres depuis `param_schema ∩ input_fields` de chaque modèle : ratio, résolution, durée, vitesse/mode, caméra, images de référence et options spécifiques. Aucun paramètre non accepté n'est affiché ni envoyé. Les modes disponibles sont dérivés des champs réels : **Text to Video** et **Image to Video** avec modèles vérifiés ; **Video to Video** est un espace préparé tant qu'aucun modèle correspondant n'est intégré.

Avant le lancement, une confirmation explicite avec case à cocher reprend le modèle, les paramètres, le coût serveur estimé en crédits, le solde, le solde après réservation et les règles d'idempotence/capture/restitution. Le suivi professionnel affiche brouillon → en attente → soumission fournisseur → génération → traitement du résultat → terminé, avec variantes échec/annulé ; la poursuite après fermeture de page reste assurée par le webhook MuAPI, le worker et le cron livrés.

---

## 2. Pile technique

- **Frontend** : React 18 + TypeScript strict + Vite 6 + Tailwind CSS 3 + React Router 6 + lucide-react
- **Backend** : Supabase (PostgreSQL 17, Auth, Storage, PostgREST, Edge Functions Deno, **pg_cron + pg_net + Vault**)
- **Schéma** : `saas_ugc` existant **conservé et réutilisé** (32 tables, 31 vues `security_invoker`) + 8 tables Reelora + 1 table `ugc_video_models` + 9 vues `public.reelora_*`
- **IA textuelle** : Groq (`llama-3.3-70b-versatile`) — scripts, accroches, dialogues, contenus publicitaires
- **IA vidéo** : **MuAPI uniquement** (`https://api.muapi.ai/api/v1`, en-tête `x-api-key`). HeyGen et fal.ai ne sont **pas** utilisés.
- **Tests** : Vitest — 85 tests (`tests/muapi.test.ts`, `studio-ux.test.ts`, `credits.test.ts`, `security.test.ts`, `errors.test.ts`, `format.test.ts`, `ui.test.tsx`)
- **Déploiement** : Preview Netlify de PR #2 `https://deploy-preview-2--saas-ugc-growth.netlify.app` (indépendante de `main`) ; accès soumis à la protection de l'équipe Netlify. Production **non déployée** et `main` inchangé.

Projet Supabase cible : `xbuuhfwobrafcbgtdgjx` (`eu-central-1`). Le projet Sofia Immobilier Lab (`yswsildmbeomjlyofnrk`) n'est **jamais** modifié.

---

## 3. Architecture & sécurité

```
Navigateur (React, clé PUBLISHABLE uniquement)
  ├─ PostgREST : vues public.ugc_* / public.reelora_* protégées par RLS
  └─ functions.invoke('reelora-ai' | 'reelora-video')  ── JWT utilisateur
                         │
       Edge Functions (verify_jwt = true pour AI & vidéo)
         ├─ GROQ_API_KEY (texte) / MUAPI_API_KEY (vidéo)  ── secrets SERVEUR
         ├─ GoTrue /auth/v1/user (validation du JWT + uid)
         ├─ RPC SECURITY DEFINER (search_path = '')
         └─ SUPABASE_SERVICE_ROLE_KEY (finalisation, stockage, quota)

MuAPI  ── POST /api/v1/{model} ──> request_id
       ├──?webhook=<worker?mode=webhook&token=…>──┐
       └── GET /api/v1/predictions/{id}/result ◄──┤  (le callback n'est JAMAIS
                                                  │   cru : état re-vérifié serveur)
pg_cron '* * * * *' ── pg_net.http_post ─────────┴──> reelora-video-worker
                                                       (verify_jwt=false, jeton Vault)
                                                       ├─ reelora_video_tick : expire + claim
                                                       ├─ upload MP4 -> Storage privé
                                                       └─ finalize_generation / refund
```

- **Le suivi ne dépend jamais de la page ouverte** : webhook MuAPI (signal de réveil) + worker `pg_cron` chaque minute (filet de sécurité). Les deux passent par un jeton aléatoire stocké dans `vault.decrypted_secrets` (`reelora_worker_token`), comparé en temps constant. MuAPI ne documente **aucune signature HMAC** : le corps du callback n'est jamais utilisé comme source de vérité, l'état est relu via `GET /predictions/{id}/result`.
- `MUAPI_API_KEY` n'est lue que dans les Edge Functions. Jamais `VITE_*`, jamais dans le frontend, jamais dans une réponse HTTP ; les messages d'erreur MuAPI passent par `redact()` qui remplace la clé par `[REDACTED]` avant tout log/réponse. Tests : `tests/security.test.ts` + `tests/muapi.test.ts`.
- `reelora-health` (`verify_jwt=false`) ne renvoie que des **booléens de présence** : `{groq, muapi, supabase, worker}`.
- Toutes les tables ont RLS. Les nouveaux RPC serveur (`reelora_claim_generation_submission`, `reelora_release_video_quota`, `reelora_record_video_poll`, `reelora_video_tick`, `reelora_worker_token`, `reelora_sync_video_models`) sont **révoqués pour `anon`/`authenticated`** et accordés uniquement à `service_role`, avec contrôle `auth.jwt()->>'role'`.
- Catalogue : `saas_ugc.ugc_video_models` expose 5 modèles dont l'endpoint et les champs ont été vérifiés dans les docs/Playground officiels. `reelora-video {action:"models"}` rafraîchit **uniquement les métadonnées** (coût, description, `is_enabled`, `is_coming_soon`) depuis `GET /api/v1/models` ; aucun endpoint ou paramètre ne peut être introduit par le catalogue live. La vue RLS masque les modèles désactivés ou « coming soon ».
- **Crédits** : `reelora_start_generation(project, service, payload, idempotency_key)` crée la tâche puis réserve les crédits via `ugc_private.apply_wallet_delta` (clé `reserve-job:<id>`) et consomme une unité de quota vidéo. Un replay du même `idempotency_key` renvoie **le même job** (`on conflict (created_by, request_key) do nothing`) : aucune double réservation, aucun double débit. `reelora_claim_generation_submission` garantit un seul `POST` MuAPI. Débit définitif uniquement si `finalize_generation(...,'succeeded')` ; restitution automatique sur échec fournisseur, image manquante, script absent, annulation autorisée ou **expiration 45 min**. Aucun crédit gratuit mensuel n'a été ajouté. Le ledger et `ugc_job_events` tracent tout.
- Stockage privé `ugc-assets` : policies exigeant que le premier dossier soit l'identifiant du workspace et que l'utilisateur en soit membre/éditeur. Le navigateur n'obtient que des URL signées (1 h).
- `supabase/config.toml` : `reelora-ai` et `reelora-video` en `verify_jwt = true` ; `reelora-health` et `reelora-video-worker` en `false` (ce dernier protégé par le jeton Vault).

### Modèles MuAPI vérifiés

| `model_id` | Endpoint | Requis | Paramètres supportés | Coût indicatif |
| --- | --- | --- | --- | --- |
| `seedance-lite-t2v` | `POST /api/v1/seedance-lite-t2v` | `prompt` | `aspect_ratio`, `resolution`, `duration`, `camera_fixed` | 0,100 USD |
| `veo3-fast-text-to-video` | `POST /api/v1/veo3-fast-text-to-video` | `prompt` | `aspect_ratio` (`16:9`/`9:16`) uniquement | 0,600 USD |
| `grok-imagine-text-to-video` | `POST /api/v1/grok-imagine-text-to-video` | `prompt` | `aspect_ratio`, `mode`, `resolution`, `duration` | 0,150 USD |
| `seedance-lite-i2v` | `POST /api/v1/seedance-lite-i2v` | `prompt`, `image_url` | `resolution`, `duration`, `camera_fixed` | 0,100 USD |
| `kling-o1-standard-image-to-video` | `POST /api/v1/kling-o1-standard-image-to-video` | `prompt`, `image_url` | `duration` (5/10) | 0,500 USD |

Sources : `https://muapi.ai/docs/api-reference`, `/docs/webhooks`, `/docs/models`, `/api/v1/models`, `https://muapi.ai/playground/<model>/llms.txt`. Les modèles `group_of:"avatar"` du catalogue exigent `audio_url` ; Reelora n'a pas de pipeline TTS et ne les expose donc pas. Aucune capacité « script → lipsync » n'est annoncée.

### Migrations

| Fichier | Rôle |
| --- | --- |
| `20261108000001…00008_reelora_*.sql` | Schéma v1, RPC, seed, correctifs quota/remboursement (déjà appliqués en live) |
| `20261108000009_reelora_muapi.sql` | `pg_net`, table `ugc_video_models` + vue RLS, 5 modèles vérifiés, colonnes de suivi sur `ugc_generation_jobs`, jeton Vault, `reelora_start_generation` idempotent, 4 RPC serveur, paramètres `video_defaults`, cron `reelora-video-tick` |
| `20261108000010_reelora_muapi_sync.sql` | Wrappers PostgREST `reelora_worker_token` / `reelora_sync_video_models` (service-role only) |
| `20261108000011_reelora_muapi_catalog_cast.sql` | Normalisation `is_enabled`/`is_coming_soon` numériques du catalogue live |
| `20261108000012_reelora_muapi_progress.sql` | Mirroir de l'état fournisseur dans `result_payload` (vue publique historique à liste de colonnes explicite) |
| `20261108000013_reelora_studio_library.sql` | RPC RLS `reelora_attach_asset_to_project` : rattacher une création existante à un projet, sans nouvelle architecture de crédits |
| `20261108000014…00015_reelora_avatar_provider_*.sql` | Alias `muapi`/`custom`/`legacy` pour les fiches d'avatar, valeurs historiques conservées, aucun fournisseur retiré nommé dans l'application |

Versions live correspondantes : `20261108223923 reelora_muapi_v1`, `20261108224022 reelora_muapi_sync`, `20261108224047 reelora_muapi_catalog_cast`, `20261108231047 reelora_muapi_progress`, puis `reelora_studio_library`, `reelora_avatar_provider_alias` et `reelora_avatar_provider_generic`. **Aucune table, vue ni donnée préexistante n'a été supprimée** (test automatisé).

### Edge Functions déployées (live)

| Slug | Version | `verify_jwt` |
| --- | --- | --- |
| `reelora-health` | v2 | `false` |
| `reelora-ai` | v2 | `true` |
| `reelora-video` | v3 | `true` |
| `reelora-video-worker` | v1 | `false` (jeton Vault) |

> Les sources de `reelora-video` et du worker contiennent des améliorations additives pour la signature serveur des images de référence et l'enrichissement des métadonnées de résultat. Ces versions de source ne sont **pas redéployées** pendant la phase Preview : le frontend reste compatible avec les versions live ci-dessus en transmettant des URL Storage signées. Aucun déploiement backend de production n'a été déclenché.

---

## 4. Variables d'environnement

### Frontend — `.env.local` (voir `.env.example`)

| Variable | Obligatoire | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | oui | URL du projet Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | oui | Clé **publishable** (ou anon legacy). Jamais `sb_secret_*` ni `service_role` |
| `VITE_SITE_URL` | recommandé | Origine publique utilisée dans `emailRedirectTo` |

Tout ce qui commence par `VITE_` est **public** : n'y placez jamais une clé d'API.

### Serveur — secrets Supabase Edge Functions

| Secret | Obligatoire | Usage |
| --- | --- | --- |
| `MUAPI_API_KEY` | **oui** | Fournisseur vidéo principal, en-tête `x-api-key` dans `reelora-video` et `reelora-video-worker` |
| `GROQ_API_KEY` | **oui** | Scripts, prompts, accroches, dialogues (Groq) |
| `GROQ_MODEL` | non | Défaut `llama-3.3-70b-versatile` |
| `REELORA_WEBHOOK_BASE_URL` | non | URL publique du worker si elle diffère de `${SUPABASE_URL}/functions/v1/reelora-video-worker` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement. Le jeton worker est **généré par la migration 00009** dans Supabase Vault (`reelora_worker_token`) ; il n'y a rien à configurer manuellement et il n'est jamais exposé.

```bash
supabase secrets set MUAPI_API_KEY=... GROQ_API_KEY=... --project-ref xbuuhfwobrafcbgtdgjx
```

> Aucun secret HeyGen / fal.ai n'est nécessaire ni lu. Les anciennes variables `REELORA_VIDEO_PROVIDER`, `HEYGEN_API_KEY`, `FAL_KEY` ont été retirées de `.env.example` et du code vidéo.

---

## 5. Installation & commandes

```bash
git clone https://github.com/ibrahimdiango514/SaaS-UGC.git
cd SaaS-UGC
cp .env.example .env.local        # ajuster VITE_SITE_URL si besoin
npm ci
npm run dev                      # http://localhost:5173
npm run typecheck                # TypeScript strict, sans erreur
npm test                         # Vitest : 85 tests
npm run build                    # tsc -b && vite build -> dist/
npm run preview                  # prévisualisation de la compilation
```

Reconstruction du backend depuis un projet vierge :

```bash
supabase link --project-ref xbuuhfwobrafcbgtdgjx
supabase db push
supabase functions deploy reelora-health --no-verify-jwt
supabase functions deploy reelora-ai
supabase functions deploy reelora-video
supabase functions deploy reelora-video-worker --no-verify-jwt
```

> ⚠️ Ne jamais déployer `reelora-ai` / `reelora-video` avec `--no-verify-jwt`. Le worker compense l'absence de JWT par le jeton Vault + la re-vérification serveur de l'état MuAPI.

---

## 6. Tests & résultats

| Suite | Résultat |
| --- | --- |
| `npm run typecheck` | ✅ 0 erreur |
| `npm test` | ✅ **85/85 tests**, 7 fichiers — 28 tests MuAPI (auth, clé absente, solde insuffisant, réservation, absence de double débit/double soumission, images Storage signées, `last_image` conditionnel, métadonnées de résultat, suivi, remboursement, webhook + cron), 11 tests UX Studio, 17 sécurité, 7 crédits/estimation, 6 erreurs, 10 formatage, 6 UI |
| `npm run build` | ✅ `dist/index.html` 1,25 kB, CSS 51,49 kB (9,25 kB gzip), JS 702,09 kB (190,59 kB gzip), 1668 modules |
| `GET /functions/v1/reelora-health` | ✅ `{"groq":false,"muapi":false,"supabase":true,"worker":true}` |
| `GET /functions/v1/reelora-video` sans jeton | ✅ `UNAUTHORIZED_NO_AUTH_HEADER` (passerelle JWT) |
| `GET /functions/v1/reelora-video-worker` | ✅ `METHOD_NOT_ALLOWED` (POST uniquement, fonction déployée) |
| **Chaîne serveur live** | ✅ `cron.job` `reelora-video-tick` actif, 5 exécutions `succeeded`, `net._http_response` → **HTTP 200** `{"mode":"tick","expired":0,"checked":0,"outcomes":[]}` : pg_cron → pg_net → worker → RPC validé en conditions réelles |
| **Sonde SQL transactionnelle (`ROLLBACK`)** | ✅ 5 modèles visibles pour `anon` via RLS ; `reelora_start_generation` appelé 2× avec la même clé → **1 seul job**, 1 seule écriture ledger `reserve`, solde 9 → 0 ; annulation → solde 9 ; `reelora_video_tick` exécutable en `service_role` uniquement |
| **Solde insuffisant (SQL live)** | ✅ `insufficient_credits` levé, **0 job** créé, **0 écriture ledger** |
| **Job abandonné / expiration (SQL live)** | ✅ `reelora_video_tick` → `expired:1`, statut `failed`, `error_code=timeout`, solde restitué 9 → crédits récupérés, événement de quota supprimé |
| Anciennes suites SQL (v1) | ✅ RLS, isolation, remboursements sécurisés, cycle réservation/annulation |

Les tests MuAPI sont **entièrement mockés** (`fetch` stubé) : aucun appel réel à MuAPI, aucune clé requise, aucune vidéo fictive enregistrée. Les sondes SQL ont été exécutées en transaction annulée : aucune donnée de test persistée.

---

## 7. Configuration requise (intervention utilisateur)

1. **Obligatoire — `MUAPI_API_KEY`** : secret Supabase Edge Functions, jamais `VITE_*`. Sans lui, `reelora-video` répond `MUAPI_NOT_CONFIGURED`, marque la tâche `failed` et restitue les crédits. **Aucune génération vidéo réelle n'a pu être testée** tant que ce secret n'est pas fourni. Une valeur littérale a été évoquée dans la demande alors que le texte précisait aussi qu'elle serait fournie ultérieurement : **aucune valeur n'a été recopiée, commitée ou définie comme secret**. Une confirmation explicite est demandée avant de l'activer côté serveur.
2. **Obligatoire — `GROQ_API_KEY`** : sans lui, `reelora-ai` répond `GROQ_NOT_CONFIGURED`. Un script saisi manuellement reste utilisable.
3. **Vérifier le catalogue live** : après ajout de la clé, ouvrir le Video Studio → « Catalogue MuAPI vérifié » → Actualiser. `reelora-video {action:"models"}` interroge `GET /api/v1/models` et met à jour les coûts/disponibilités. Si un modèle vérifié passe `is_enabled:0`, il est masqué automatiquement.
4. **Tester une vraie génération** avec un compte disposant d'au moins 9 crédits, un projet, une description d'au moins 20 caractères, puis cocher la confirmation explicite. Vérifier le `request_id` dans My Generations, la vidéo dans Mes créations enregistrées et les écritures `reserve` → `capture` dans le ledger.
5. **Webhook** : `reelora-video` construit `?webhook=` automatiquement à partir de `SUPABASE_URL`. Si l'URL publique du projet diffère, définir `REELORA_WEBHOOK_BASE_URL`. Le cron reste actif même si MuAPI n'appelle pas le webhook.
6. **`site_url`** du projet partagé vaut encore `https://sbc-ai-agency-dashbord.netlify.app`. Reelora passe `emailRedirectTo` explicite et l'allowlist contient `https://reelora.netlify.app/**`. Ajouter l'origine de production avant déploiement.
7. **Paiement** : les recharges restent `pending` jusqu'à confirmation manuelle par un administrateur. Aucune passerelle automatique simulée.
8. **Preview Netlify** : la PR #2 publie automatiquement `https://deploy-preview-2--saas-ugc-growth.netlify.app`, sans toucher `main` ni la production. L'URL est actuellement protégée par la politique d'accès de l'équipe Netlify : le propriétaire doit ouvrir la Preview avec son compte Netlify ou désactiver cette protection pour un test public. Aucun déploiement de production n'a été déclenché.

---

## 8. Structures de données notables

- `saas_ugc.ugc_*` : schéma métier d'origine (profils, portefeuilles, espaces, projets, scripts, scènes, tâches, assets, services, tarifs, ledger, notifications…).
- Ajouts Reelora : `ugc_avatars`, `ugc_prompt_templates`, `ugc_generation_presets`, `ugc_plans`, `ugc_subscriptions`, `ugc_usage_events`, `ugc_notifications`, `ugc_audit_logs`, **`ugc_video_models`**.
- Colonnes de suivi ajoutées à `ugc_generation_jobs` : `provider_status`, `next_poll_at`, `last_polled_at`, `poll_attempts`, `expires_at`, `webhook_received_at`, `submission_claim_id`, `muapi_cost`.
- Formules : `Découverte` (gratuit, 9 crédits, 1 vidéo/mois), `Studio`, `Pro`, `Enterprise`. **Aucun crédit gratuit mensuel ajouté.**
- Services actifs : `script=2`, `image_retouch=3`, `product_image=3`, `cutaway=10`, `ugc_clip_8s=9`, `ugc_clip_15s=16`, `ugc_ad_4clips=36` crédits.

---

## 9. Bonnes pratiques d'usage

- Une description de scène est obligatoire ; le script voix off Groq est optionnel et sert de contexte. Un modèle image → vidéo exige une image de référence importée dans Storage privé ; un modèle texte → vidéo n'en a pas besoin. Le Video Studio désactive le lancement tant qu'une condition réelle manque.
- Le coût en crédits **et** le coût fournisseur estimé sont affichés avant une confirmation explicite. Les crédits ne sont jamais débités pour une génération échouée ; l'historique détaille chaque réservation, consommation et restitution.
- Le suivi continue côté serveur (webhook + cron) : fermer l'onglet n'interrompt pas la génération. Un job en cours se reprend depuis l'historique ou `?job=<id>`.
- Les modèles de prompts système sont en lecture seule : copiez-les pour les personnaliser.
- L'administration est réservée aux utilisateurs avec le rôle `admin` (`ibrahimdiango514@gmail.com` initialisé).

---

© 2026 Reelora. Hébergement Supabase `eu-central-1`. Aucune donnée de démonstration ni aucun résultat de génération n'est présenté comme réel.
