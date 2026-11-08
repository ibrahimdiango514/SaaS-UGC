# Reelora — Studio UGC propulsé par l'IA

SaaS francophone de création de contenus UGC (User Generated Content) : scripts publicitaires générés par IA, avatars, génération vidéo réelle, bibliothèque privée, crédits/quotas et administration. Ce dépôt contient **l'intégralité des sources** (frontend, migrations SQL, Edge Functions, configuration, tests). Rien n'est une maquette : chaque écran est relié à Supabase et aux services d'IA côté serveur.

> **Important** — Les clés d'API des fournisseurs externes ne sont pas incluses. Sans elles, Reelora affiche une erreur explicite (`GROQ_NOT_CONFIGURED`, `VIDEO_PROVIDER_NOT_CONFIGURED`), ne produit **aucun faux résultat** et restitue les crédits réservés. Voir [Configuration requise](#configuration-requise-intervention-utilisateur).

---

## 1. Fonctionnalités

| Domaine | Implémentation |
| --- | --- |
| Pages publiques | Accueil avec formules **chargées depuis la base**, fonctionnalités, workflow, FAQ, confidentialité, conditions, 404 |
| Authentification | Inscription, connexion, mot de passe oublié, callback Supabase, réinitialisation, déconnexion, session persistante |
| Tableau de bord | Statistiques réelles (projets, vidéos, crédits, bibliothèque), quotas, dernières générations, état des intégrations |
| Projets | Création, recherche, filtre par statut, fiche détaillée, édition du brief, scripts, scènes, générations, suppression |
| UGC Studio | Sélection projet/script/avatar/préréglage, réglages vidéo, réservation de crédits, soumission au fournisseur, **polling réel** jusqu'à succès/échec, annulation |
| Avatars | CRUD, fournisseur (HeyGen / fal.ai / personnalisé), identifiant fournisseur, voix, image de référence uploadée dans `ugc-assets`, avatar par défaut |
| Scripts IA | Génération Groq (accroche, script, CTA, angle, allégations à éviter, storyboard), accroches alternatives, enregistrement en base, approbation, copie, suppression |
| Prompts | CRUD de modèles, variables `{{...}}`, aperçu d'interpolation, favoris, modèles système en lecture seule, amélioration par Groq |
| Réglages vidéo | CRUD de préréglages (fournisseur, durée, format, résolution, style, vitesse de voix, sous-titres, fond, modèle fal.ai) |
| Bibliothèque | Vidéos réellement générées, URL signées, lecteur, téléchargement, suppression du fichier et de la fiche |
| Historique | Toutes les tâches, événements de production, filtres, annulation, journal des mouvements de crédits |
| Abonnement | 4 formules issues de la base, quotas mensuels, demande de changement, commandes de recharge, codes promotionnels, mouvements de crédits |
| Profil & paramètres | Profil, espace de travail, membres, sécurité (mot de passe / e-mail), marques, produits, état des intégrations |
| Administration | Vue d'ensemble, utilisateurs/rôles, suspension, attribution de formule, ajustement de crédits, confirmation des recharges, catalogue de services, paramètres JSON, journal d'audit |
| Transverse | Interface 100 % française, mobile-first, responsive, états de chargement/erreur/vide, notifications (toasts + centre de notifications), error boundary |

---

## 2. Pile technique

- **Frontend** : React 18 + TypeScript strict + Vite 6 + Tailwind CSS 3 + React Router 6 + lucide-react
- **Backend** : Supabase (PostgreSQL 17, Auth, Storage, PostgREST, Edge Functions Deno)
- **Schéma** : `saas_ugc` existant **conservé et réutilisé** (32 tables, 31 vues `security_invoker`) + 8 tables Reelora et 8 vues `public.reelora_*`
- **IA** : Groq (`llama-3.3-70b-versatile`) pour les scripts/prompts ; HeyGen (avatar parlant) ou fal.ai / Kling (image → vidéo) pour la vidéo
- **Tests** : Vitest (34 tests, dont 6 parcours UI en jsdom) + suites SQL de contrôle RLS/RPC
- **Déploiement** : Netlify (configuration fournie, **non déployé** conformément à la consigne)

Projet Supabase cible : `xbuuhfwobrafcbgtdgjx` (`eu-central-1`). Le projet Sofia Immobilier Lab (`yswsildmbeomjlyofnrk`) n'est **jamais** modifié.

---

## 3. Architecture & sécurité

```
Navigateur (React)
  ├─ supabase-js : clé PUBLISHABLE uniquement
  ├─ PostgREST   : vues public.ugc_* / public.reelora_* protégées par RLS
  └─ functions.invoke('reelora-ai' | 'reelora-video')  ── JWT utilisateur
                                  │
                    Edge Functions (verify_jwt = true)
                      ├─ GROQ_API_KEY / HEYGEN_API_KEY / FAL_KEY  (secrets serveur)
                      ├─ GoTrue /auth/v1/user (validation du JWT)
                      ├─ RPC SECURITY DEFINER (search_path = '')
                      └─ SUPABASE_SERVICE_ROLE_KEY (uniquement pour finalisation,
                         stockage et remboursement de quota)
```

- Aucune clé secrète, aucun jeton `service_role`, aucun `Deno.env.get` dans `src/`. Test automatisé : `tests/security.test.ts`.
- Toutes les tables ont RLS. Les RPC `reelora_*` sont `SECURITY DEFINER` avec `search_path = ''`, `anon`/`public` révoqués, et vérifient `auth.uid()` ou le rôle.
- Les RPC réservées au serveur (`reelora_set_job_processing`, `reelora_finalize_generation`, `reelora_refund_quota(text,uuid,uuid)`) ne sont exécutables **que** par `service_role` et vérifient `auth.jwt()->>'role'`.
- Le remboursement de quota n'est plus contournable : la variante service exige un utilisateur vérifié, un événement récent et, pour la vidéo, une tâche réellement `failed`/`cancelled`. La variante 2 arguments (compatibilité `reelora-video`) n'accepte que `video` avec tâche échouée.
- Crédits : réservés au lancement, consommés uniquement sur succès, restitués sur échec/annulation. Les événements de quota sont supprimés lors d'un remboursement légitime et chaque remboursement est journalisé.
- Stockage privé `ugc-assets` : 4 policies exigent que le premier dossier soit l'identifiant de l'espace de travail et que l'utilisateur en soit membre/éditeur. Le frontend n'obtient que des URL signées (1 h).
- `netlify.toml` ajoute `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` et un cache immuable sur `/assets/*`.
- `supabase/config.toml` : `reelora-ai` et `reelora-video` en `verify_jwt = true` ; seule la sonde `reelora-health` est publique et ne renvoie que des booléens de présence.

### Migrations appliquées

| Fichier | Rôle |
| --- | --- |
| `20261108000001_reelora_schema.sql` | 8 tables, vues, RLS, grants, policies de lecture admin |
| `20261108000002_reelora_rpc.sql` | ~23 RPC métier et d'administration |
| `20261108000003_reelora_seed.sql` | 4 formules, tarifs ML/FR, 7 services actifs, paramètres, 6 prompts système, promo `REELORA2026`, comptes initiaux |
| `20261108000004_reelora_fix_usage_reference.sql` | Référence de quota = identifiant de la tâche |
| `20261108000005_reelora_refund_quota.sql` | Remboursement initial (remplacé par les migrations 6–8) |
| `20261108000006_reelora_secure_refund.sql` | Remboursement service-role uniquement + durcissement des RPC serveur |
| `20261108000007_reelora_legacy_video_refund.sql` | Compatibilité sécurisée pour `reelora-video` v1 |
| `20261108000008_reelora_disambiguate_refund.sql` | Suppression de l'ambiguïté de surcharge PostgREST |

Aucune table ni vue préexistante n'est supprimée (test automatisé).

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
| `GROQ_API_KEY` | **oui** | Scripts, prompts, accroches, amélioration de prompts |
| `GROQ_MODEL` | non | Défaut `llama-3.3-70b-versatile` |
| `REELORA_VIDEO_PROVIDER` | non | `heygen` (défaut) ou `fal` |
| `HEYGEN_API_KEY` | si `heygen` | `POST /v2/video/generate` + `GET /v1/video_status.get` |
| `HEYGEN_DEFAULT_VOICE_ID` | non | Voix par défaut |
| `FAL_KEY` | si `fal` | `https://queue.fal.run` |
| `FAL_MODEL` | non | Défaut `fal-ai/kling-video/v1.6/standard/image-to-video` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement par Supabase.

```bash
# Exemple (Supabase CLI)
supabase secrets set GROQ_API_KEY=... --project-ref xbuuhfwobrafcbgtdgjx
supabase secrets set REELORA_VIDEO_PROVIDER=heygen HEYGEN_API_KEY=... --project-ref xbuuhfwobrafcbgtdgjx
```

---

## 5. Installation & commandes

```bash
git clone https://github.com/ibrahimdiango514/SaaS-UGC.git
cd SaaS-UGC
cp .env.example .env.local        # ajuster VITE_SITE_URL si besoin
npm ci
npm run dev                      # http://localhost:5173
npm run typecheck                # TypeScript strict, sans erreur
npm test                         # Vitest : 28 tests
npm run build                    # tsc -b && vite build -> dist/
npm run preview                  # prévisualisation de la compilation
```

Reconstruction du backend (si l'on repart d'un projet Supabase vierge) :

```bash
supabase link --project-ref xbuuhfwobrafcbgtdgjx
supabase db push                       # applique supabase/migrations/*.sql
supabase functions deploy reelora-health --no-verify-jwt   # SEULE la sonde
supabase functions deploy reelora-ai
supabase functions deploy reelora-video
```

> ⚠️ Ne jamais déployer `reelora-ai` / `reelora-video` avec `--no-verify-jwt`.

---

## 6. Tests & résultats

| Suite | Résultat |
| --- | --- |
| `npm run typecheck` | ✅ 0 erreur |
| `npm test` | ✅ 34/34 tests (formatage, erreurs, sécurité des secrets, contrat RPC, reconstructibilité, 6 parcours UI : accueil, inscription, validation de connexion, route protégée, 404, confidentialité) |
| `npm run build` | ✅ `dist/index.html`, CSS 41,84 kB, JS 608,75 kB (165,60 kB gzip) |
| Aperçu local Vite | ✅ `HTTP 200` sur `/`, `/src/main.tsx`, `/src/App.tsx`, `/src/index.css` et le fallback SPA `/app/projets` |
| `GET /functions/v1/reelora-health` | ✅ `{"status":"ok","configured":{"groq":false,"heygen":false,"fal":false,"supabase":true}}` |
| `GET /functions/v1/reelora-ai`, `/reelora-video` sans jeton | ✅ `UNAUTHORIZED_NO_AUTH_HEADER` : la passerelle exige bien un JWT |
| Suite SQL sous `ROLE authenticated` non-admin | ✅ bootstrap `free` / `is_admin=false`, quota, création projet, script, scènes, demande de formule, isolation des notifications et des assets |
| Suite SQL de sécurité | ✅ `admin_overview`, `admin_list_users`, `admin_set_role`, `admin_adjust_credits`, `set_job_processing`, `finalize_generation`, remboursement 3 args : **BLOCKED** |
| Cycle de génération (SQL, `ROLLBACK`) | ✅ réservation, annulation, crédits restitués (100), quota vidéo remis à 0, remboursement 2 args refusé sur tâche non échouée |
| Liste des 15 functions Edge | ✅ `reelora-health` v1 (`verify_jwt=false`), `reelora-ai` v2 (`true`), `reelora-video` v1 (`true`), toutes `ACTIVE` |

Les 34 tests automatisés sont reproductibles via `npm test`. Les suites SQL ont été exécutées contre `xbuuhfwobrafcbgtdgjx` en transaction avec `ROLLBACK` (aucune donnée de test persistée).

---

## 7. Configuration requise (intervention utilisateur)

1. **Obligatoire — `GROQ_API_KEY`** : sans ce secret serveur, `reelora-ai` répond `GROQ_NOT_CONFIGURED` (503). Aucun script n'est inventé.
2. **Obligatoire pour la vidéo — au choix** :
   - `HEYGEN_API_KEY` + `REELORA_VIDEO_PROVIDER=heygen`, avec des avatars ayant un `provider_avatar_id` HeyGen valide ;
   - ou `FAL_KEY` + `REELORA_VIDEO_PROVIDER=fal`, avec une image de référence sur l'avatar.
   Sans clé, `reelora-video` échoue avec `VIDEO_PROVIDER_NOT_CONFIGURED`, marque la tâche `failed` et restitue les crédits.
3. **`site_url` du projet Supabase** vaut encore `https://sbc-ai-agency-dashbord.netlify.app` car ce projet est partagé avec d'autres applications. Reelora passe systématiquement `emailRedirectTo` explicite et l'allowlist contient `https://reelora.netlify.app/**`. Si Reelora devient l'unique application du projet, remplacer `site_url` par l'URL de production.
4. **Allowlist de redirection** : les wildcards `https://*.e2b.app/**` et `https://*.netlify.app/**` ont été retirés ; seules les origines explicites sont autorisées. Ajouter l'origine de production et, si besoin, l'origine de prévisualisation avant un déploiement.
5. **Paiement** : les recharges créent une commande `pending`; un administrateur confirme manuellement depuis `/app/admin` après réception du paiement. Aucune passerelle de paiement automatique n'est simulée.
6. **Déploiement Netlify** : préparé (`netlify.toml`, `public/_redirects`, `NODE_VERSION=22`) mais **volontairement non effectué** avant validation finale. Renseigner `VITE_SITE_URL` et les 3 variables `VITE_*` dans l'environnement Netlify.

---

## 8. Structures de données notables

- `saas_ugc.ugc_*` : schéma métier d'origine (profils, portefeuilles, espaces, projets, scripts, scènes, tâches, assets, services, tarifs, ledger, notifications…).
- Ajouts Reelora : `ugc_avatars`, `ugc_prompt_templates`, `ugc_generation_presets`, `ugc_plans`, `ugc_subscriptions`, `ugc_usage_events`, `ugc_notifications`, `ugc_audit_logs`.
- Formules : `Découverte` (gratuit, 9 crédits, 1 vidéo/mois), `Studio`, `Pro`, `Enterprise` — données réelles de `reelora_plans`.
- Services actifs : `script=2`, `image_retouch=3`, `product_image=3`, `cutaway=10`, `ugc_clip_8s=9`, `ugc_clip_15s=16`, `ugc_ad_4clips=36` crédits.

---

## 9. Bonnes pratiques d'usage

- Un script doit être généré ou saisi avant de lancer une vidéo ; un avatar doit avoir un identifiant fournisseur (HeyGen) ou une image (fal.ai). L'UGC Studio affiche une check-list et refuse le lancement si une condition manque.
- Les crédits ne sont jamais débités pour une génération échouée ; l'historique détaille chaque réservation, consommation et restitution.
- Les modèles de prompts système sont en lecture seule : copiez-les pour les personnaliser.
- L'administration est réservée aux utilisateurs avec le rôle `admin` (`ibrahimdiango514@gmail.com` initialisé). `AdminRoute` et les RPC refusent tout accès aux autres comptes.

---

© 2026 Reelora. Hébergement Supabase `eu-central-1`. Aucune donnée de démonstration n'est présentée comme réelle.
