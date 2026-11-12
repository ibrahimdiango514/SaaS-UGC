# État du dépôt Git — reprise du développement depuis VS Code

> Vérifié le **12 novembre 2026** sur `ibrahimdiango514/SaaS-UGC`.
> Dépôt de travail : `/home/user/SaaS-UGC`. Working tree **propre**, aucun fichier non suivi.
> 282 fichiers suivis · 42 commits dans l'historique complet · 90 fichiers TS/TSX dans `src/`.

---

## 0. Réponse directe : sur quelle branche travailler dans VS Code ?

```
git clone https://github.com/ibrahimdiango514/SaaS-UGC.git
cd SaaS-UGC
git checkout arena/323bad30-saas-ugc
npm ci
```

**Branche à utiliser : `arena/323bad30-saas-ugc` (commit `ff49e4e`).**

C'est la **seule branche qui contient tout le travail récent**. Elle est en avance de
**5 commits** sur `main` et ne lui manque **aucun** commit (`main` a 0 commit qu'elle n'a pas) :

```
git rev-list --left-right --count origin/main...HEAD
0    5        # main a 0 commit en plus · la branche a 5 commits en plus
```

> ⚠️ **`main` est en retard.** Si vous clonez et restez sur `main`, vous n'aurez **ni** la
> continuité Business Grow ↔ Studio UGC, **ni** la surveillance `pg_cron`, **ni** les correctifs
> CORS/incident du 12 novembre. Ils ne rejoindront `main` qu'à la fusion de la PR #6, que je ne
> fusionne pas sans votre accord.

---

## 1. Branches

### Branche courante

| | |
| --- | --- |
| Nom | `arena/323bad30-saas-ugc` |
| Dernier commit | `ff49e4e` — *fix(business-grow): rétablir le backend prod et la surveillance des fournisseurs* |
| Date | 2026-11-12 00:39:58 UTC |
| Suivi | `origin/arena/323bad30-saas-ugc` — **à jour** (aucun écart local/distant) |
| État | Working tree propre |

### Branches locales (2)

| Branche | Commit | Suivi | Rôle |
| --- | --- | --- | --- |
| `arena/323bad30-saas-ugc` *(courante)* | `ff49e4e` | `origin/arena/323bad30-saas-ugc` | **Branche de travail et de la PR #6** |
| `main` | `1a572be` | `origin/main` | Branche de référence, en retard de 5 commits |

### Branches distantes (2 + HEAD)

| Référence | Commit | Note |
| --- | --- | --- |
| `origin/main` (= `origin/HEAD`) | `1a572be` | 2026-11-11 20:26 UTC |
| `origin/arena/323bad30-saas-ugc` | `ff49e4e` | Identique à la branche locale |

Aucune autre branche distante n'existe : les branches Arena des PR #1 à #5 ont été supprimées
après fusion (comportement par défaut de GitHub).

### `main` et son dernier commit

```
1a572be | 2026-11-11 15:26:10 -0500 (20:26 UTC)
Merge pull request #5 from ibrahimdiango514/arena/ae76dba9-saas-ugc
Titre : VYORA : moteur IA central, espaces continus, devis fournisseur, admin et crédits réels
```

### Pull requests

| PR | État | Branche → base | Fusion |
| --- | --- | --- | --- |
| **#6** | **OPEN** | `arena/323bad30-saas-ugc` → `main` | **non fusionnée** (volontairement) |
| #5 | MERGED | `arena/ae76dba9-saas-ugc` | 2026-11-11 20:26 UTC → `1a572be` |
| #4 | MERGED | `arena/147ca0c8-saas-ugc` | 2026-11-11 03:32 UTC → `36e8010` |
| #3 | MERGED | `arena/e22e624f-saas-ugc` | 2026-11-10 06:17 UTC |
| #2 | MERGED | `arena/603bc0c5-saas-ugc` | 2026-11-09 14:15 UTC → `cee9e5a` |
| #1 | MERGED | `arena/8d285991-saas-ugc` | 2026-11-08 21:41 UTC → `012d003` |

Une seule PR ouverte : **#6**. Checks Netlify : `deploy-preview` **pass**
(https://deploy-preview-6--vyora-ugc.netlify.app), `Header rules` **pass**, `Redirect rules` **pass**.

### Différences entre les branches

`main..HEAD` — **5 commits, 28 fichiers, +2 653 / −23 lignes** :

| Commit | Date | Sujet | Portée |
| --- | --- | --- | --- |
| `ff49e4e` | 12/11 | fix(business-grow): rétablir le backend prod et la surveillance | CORS, migration ambiguïté, README, rapport d'incident |
| `a71ac8e` | 11/11 | feat(ops): job pg_cron de surveillance des fournisseurs IA | `vyora-provider-health`, migration cron (775 l.), admin, tests |
| `7e4ffdc` | 11/11 | docs: preuves de vérification réelle des fournisseurs | Documentation seule |
| `2318f5b` | 11/11 | fix(edge): aligner la sonde IA sur les secrets réels + origines e2b | `business-grow`, `reelora-ai`, `reelora-health` |
| `80a0064` | 11/11 | feat(vyora): continuité Business Grow ↔ Studio UGC | Contrats, workspace, alerte péremption, tests |

Fichiers les plus significatifs du diff :

```
supabase/migrations/20261111234500_vyora_provider_health_cron.sql   | 775 +++++++
supabase/functions/vyora-provider-health/index.ts                   | 275 +++++
supabase/migrations/...dispatch_ambiguity.sql (nouveau)             |  65 ++
src/pages/admin/AdminSections.tsx                                   | 129 ++-
src/contracts/business-grow.ts                                      | 110 ++
src/lib/api.ts                                                      |  65 ++
src/business/BusinessGrowWorkspace.tsx                              |  57 ++-
docs/ (6 nouveaux documents)                                        | 543 ++++
tests/ (5 fichiers, dont provider-health-cron 179 l.)               | 512 ++++
```

---

## 2. Commits qui portent des fonctionnalités importantes

Historique complet (42 commits, du plus récent au plus ancien). En **gras** : les jalons.

| Commit | Sujet | Ce qu'il apporte |
| --- | --- | --- |
| **`ff49e4e`** | fix business-grow prod | CORS prod, cron réparé, incident documenté |
| **`a71ac8e`** | job pg_cron surveillance IA | `vyora-provider-health`, 4 jobs, panneau admin, 179 tests |
| `7e4ffdc` | preuves fournisseurs | Preuves Gemini/Groq horodatées |
| `2318f5b` | sonde IA + origines e2b | Alignement secrets, CORS aperçus |
| **`80a0064`** | continuité Business Grow ↔ Studio | Contrats partagés, alerte de péremption |
| **`1a572be`** | *(main)* merge PR #5 | **Tout le socle actuel de `main`** |
| **`eefddc3`** | moteur IA central, espaces continus, devis, admin, crédits | `vyora-ai`, crédits réels, admin |
| `38d5da9` | doc état prod | — |
| `6a8f43e` | isolation admin/client | RLS, entitlements |
| `a4f2892` | premier propriétaire admin | Bootstrap sécurisé |
| `dae03d3` | budget fournisseur admin | Plafonds, dépenses |
| `0d7f692` | refresh produit + garde dépense vidéo | — |
| `36e8010` | merge PR #4 | — |
| `b62b33f` | relais Netlify + auto-routage | `netlify/edge-functions` |
| `4fcd8dc` | fallback modèle préféré | Fallback IA |
| `83f7aaf` | relais preview Netlify + vérif fournisseur stricte | — |
| `ad72c11` | routage IA central + contrats plateforme | `ai_routing_rules`, contrats |
| **`e657843`** | fournisseurs IA centraux, routage, outils | Socle du moteur IA |
| `915bf43` | merge VS Code Business Grow & Studio | — |
| `9eec20f` | isolation comptes | — |
| `b487f71` | workspace + fiabilité | — |
| **`e728a17`** | moteur IA multi-fournisseurs Reelora + Business Grow core | Origine du moteur IA |
| `068709c` | Business Grow + Studio | — |
| **`930d6af`** | Phase 4 export vidéo pro | WebCodecs MP4/WebM, ExportPanel |
| `2f9c995` | correctif CORS preflight Edge | — |
| **`db4b373`** | Phase 3 montage vidéo intelligent | Timeline, éditeur |
| `a30ee86` | Phase 2 Studio UGC | Sélection, devis, états |
| `27b2ab9` | doc validation | — |
| `3b99f98` | devis à confirmer + MuAPI authentifié | — |
| `cee9e5a` | merge PR #2 | — |
| `f812b30` | catalogue MuAPI réel + devis backend | — |
| **`1d925f7`** | Video Generation Studio + AI Video Editor | Studio vidéo + timeline |
| `5fb5496` | états Groq sans simulation | — |
| `d792bc3` | UX Video Studio premium | — |
| **`ca2a04a`** | intégration réelle MuAPI | UGC Studio |
| `012d003` | merge PR #1 | — |
| **`c2a09d4`** | plateforme UGC IA complète | Frontend, migrations, Edge Functions, tests |
| `5926306`…`d67b67e` | nettoyages + initial commit | — |

---

## 3. Où se trouve chaque fonctionnalité

### Studio vidéo et fonctionnalités UGC

| Élément | Emplacement |
| --- | --- |
| Video Studio (entrée `/app/studio`) | `src/studio/GenerationStudio.tsx`, `VideoStudio.tsx`, `StudioPages.tsx` |
| Éditeur vidéo, timeline, export | `src/studio/VideoEditor.tsx`, `src/studio/editor/` (`render.ts`, `exportConfig.ts`, `audioMixer.ts`, `persistence.ts`, `projectMedia.ts`, `serverRenderSpec.ts`, `assist.ts`) |
| Composants Studio (13) | `src/studio/components/` (`CatalogBrowser`, `CostConfirm`, `DynamicParams`, `PreviewStage`, `PromptComposer`, `ProviderQuotePanel`, `StudioShell`, …) |
| Catalogue de modèles, paramètres, qualité | `src/studio/catalog.ts`, `model.ts`, `plan.ts`, `prompt.ts`, `quality.ts`, `sections.ts`, `tracking.ts` |
| Espaces préparés (Image, Avatar, V2V, Lipsync…) | `src/studio/sections.ts` → route `/app/studio/espace/:section` |
| Pages Studio | `src/pages/Studio.tsx`, `Avatars.tsx`, `Scripts.tsx`, `Prompts.tsx`, `Presets.tsx`, `Library.tsx`, `History.tsx`, `Projects.tsx`, `ProjectDetail.tsx` |
| Edge Functions | `reelora-video`, `reelora-video-worker`, `reelora-ai`, `reelora-health`, `video-quote`, `reelora-owner-bootstrap` |
| Migrations (16) | `20261108*_reelora_*.sql` (schéma v1, RPC, MuAPI, catalogue, avatars, bibliothèque) |
| Docs | `docs/phase2-finalisation-studio-ugc.md`, `phase3-montage-intelligent.md`, `phase4-moteur-export-video.md`, `video-studio-v2.md`, `modeles-muapi.md`, `correction-v2-muapi.md`, `devis-fournisseur.md` |

### Business Grow et ses fonctionnalités IA

| Élément | Emplacement |
| --- | --- |
| Workspace chat / mémoire métier | `src/business/BusinessGrowWorkspace.tsx` (≈1 500 l.) |
| **Growth OS** (9 onglets) | `src/business/growth/GrowthWorkspace.tsx` + `GrowthPanels.tsx` + `model.ts` |
| Contrats partagés | `src/contracts/business-grow.ts` |
| Pont Studio ↔ Business Grow | `src/business/bridge.ts`, `src/business/index.ts` |
| Client API | `src/business/api.ts` (direct → relais Netlify → fallback) |
| Registre IA | `src/business/ai/registry.ts` |
| Edge Function | `supabase/functions/business-grow/` (`index.ts`, `handler.ts` 986 l., `providers.ts`, `intelligence.ts`) |
| Migrations (5) | `20261110172827_business_grow_saas_business.sql` (18 tables), `…172909_ai_extensions`, `…175418_verified_catalog_sync`, `…180645_erasure_fix`, `…180955_gemini_priority` |
| Docs | `docs/business-grow-phase1.md`, `business-grow-sql-design.md`, `growth-os.md`, `business-grow-continuite-studio.md` |

Onglets réels de Growth OS : **Vue d'ensemble · Entreprise · Objectifs · Catalogue · Marché ·
Prospects (CRM) · Stratégie · Historique · Paramètres**.

### CRM

`src/business/growth/GrowthPanels.tsx` → `CrmPanel` (l. 714), onglet **« Prospects »**
(`/app/business`, onglet `crm`). Modèle : `GrowthProspect` + `PROSPECT_STAGES` dans
`model.ts` (l. 35-52, 109-115) — six étapes : *prospect → contacté → qualifié → proposition →
gagné / perdu*. Pipeline et résumé dans `PipelineSummary` (l. 286). Données persistées dans
`saas_business.memory_items` (catégorie `growth_prospect`).

### Catalogue produits

`GrowthPanels.tsx` → `CatalogPanel` (l. 305), onglet **« Catalogue »**. Import produits :
`CatalogImportProduct` / `CatalogImportResult` (`model.ts` l. 342-351). Le panneau signale
explicitement l'état « Catalogue produits partiellement indisponible »
(`GrowthWorkspace.tsx` l. 615) plutôt que d'afficher des données fictives.

### Connexions entre les modules

| Lien | Fichier |
| --- | --- |
| Studio ↔ Business Grow (continuité de session, contrat partagé) | `src/business/bridge.ts`, `src/contracts/business-grow.ts` |
| `GenerationStudio` → contexte Business Grow | `src/studio/GenerationStudio.tsx` (+46 l. au commit `80a0064`) |
| Budget provider ↔ admin | `src/pages/admin/ProviderBudgetSettings.tsx` |
| Relais HTTP Netlify (preview) | `netlify/edge-functions/business-grow.js`, `netlify/functions/business-grow.mjs`, `netlify.toml` |
| Parité frontend ↔ Edge | `tests/integration-parity.test.ts`, `scripts/check-edge-imports.mjs` |

### Administration

`src/pages/Admin.tsx` + `src/pages/admin/` : `AdminSections.tsx` (sections et panneaux),
`AdminCharts.tsx`, `CreditManager.tsx`, `ProviderBudgetSettings.tsx`.
Garde d'accès : `AdminRoute` dans `src/components/Routes.tsx` (vérification serveur du rôle).
Migrations admin : `20261111144116` (premier admin), `…150407` (dépenses par fournisseur),
`…160505` (statut bootstrap), `…165732` (isolation + entitlements), `…193000` (métriques),
`…200000` (opérations crédits).

### Moteur IA et routage Groq/Gemini

| Élément | Emplacement |
| --- | --- |
| Moteur central | `supabase/functions/vyora-ai/index.ts` (**v3 en production**) |
| Adaptateurs fournisseurs | `supabase/functions/business-grow/providers.ts` (`providerOrder` l.539, `callProvider` l.474, `probeProvider` l.494, `listRemoteModels` l.513) |
| Prompts / types | `supabase/functions/business-grow/intelligence.ts` |
| Configuration | `providerConfigs` dans `business-grow/index.ts` |
| Routage en base | `saas_business.ai_routing_rules` × `ai_roles` — **7 rôles** (`business_analysis`, `business_advisor`, `action_plan`, `content_strategy`, `marketing_campaign`, `sales_analysis`, `tool_planning`), **2 routes éligibles chacun** : `groq/openai/gpt-oss-120b` (priorité 1) → `gemini/gemini-2.5-flash` (priorité 10) |
| Sélection de route | RPC `saas_business.bg_select_route` (vérifie fournisseur + modèle `verified` + santé < 24 h) |
| Fallback | Boucle `excludedProviders` / `previousAttemptId` / `fallbackReason` dans `handler.ts` → `NO_VERIFIED_PROVIDER` en dernier recours |

### Système de crédits

| Élément | Emplacement |
| --- | --- |
| Tables | `saas_business.wallets`, `credit_ledger` (migration `…172909_ai_extensions.sql`) |
| Réservation / capture / restitution | RPC `bg_reserve_units`, `bg_capture_units`, `bg_release_units` (ACL `postgres`, `bg_edge`) |
| Tarification par action | `handler.ts` : `reserveAmount` = 2 pour `business_analysis` / `action_plan` / `sales_analysis`, sinon 1 |
| Opérations admin | `src/pages/admin/CreditManager.tsx` + migration `20261111200000_vyora_admin_credit_ops.sql` |
| Crédits Studio (UGC) | `ugc_*` / RPC `reelora_*` (migrations `20261108*`), ledger consultable dans `History.tsx` |

### Contrôles de santé des fournisseurs IA et tâches cron

| Élément | Emplacement |
| --- | --- |
| Edge Function de surveillance | `supabase/functions/vyora-provider-health/index.ts` (275 l., `verify_jwt: false` + jeton Vault + en-tête `x-vyora-cron`) |
| Migration complète | `20261111234500_vyora_provider_health_cron.sql` (775 l.) |
| Correctif d'ambiguïté | `20261112001000_vyora_provider_health_dispatch_ambiguity.sql` |
| Tables | `ai_provider_health_checks`, `provider_health_cron_runs`, `provider_health_cron_state`, `admin_alerts` |
| Jobs actifs | **8** `collect` `*/5 * * * *` · **10** `watchdog` `40 6 * * *` · **11** `daily` `0 2,14 * * *` · **12** `fresh-guard` `20 * * * *` |
| Panneau admin | `AdminSections.tsx` (« Fournisseurs IA ») + `src/lib/api.ts` (+65 l.) |
| Tests | `tests/provider-health-cron.test.ts` (179 l.), `tests/business-provider-staleness.test.tsx` (163 l.) |
| Docs | `docs/surveillance-fournisseurs-cron.md` |

### Derniers correctifs backend, CORS et disponibilité IA

| Correctif | Où | Commit |
| --- | --- | --- |
| CORS : le secret ne masque plus la liste par défaut, production toujours autorisée | `supabase/functions/business-grow/index.ts` l. 382-420 | `ff49e4e` (+ `2318f5b`) |
| `vyora_provider_health_dispatch` ambigu (`42725`) → jobs réparés | migration `20261112001000`, migration d'origine alignée | `ff49e4e` |
| Sonde IA alignée sur les secrets réels + origines `*.e2b.app` | `business-grow/index.ts`, `reelora-ai`, `reelora-health` | `2318f5b` |
| Alerte de péremption des contrôles (évite `NO_VERIFIED_PROVIDER` silencieux) | `src/business/BusinessGrowWorkspace.tsx`, `tests/business-provider-staleness.test.tsx` | `80a0064` |
| Relais Netlify (pas de secret côté client) | `netlify/edge-functions/business-grow.js` | `b62b33f` |
| CORS preflight Edge (en-tête `x-application-name` retiré) | Edge Functions | `2f9c995` |
| Documentation d'incident | `docs/incident-business-grow-prod-20261112.md` | `ff49e4e` |

### Fonctionnalités développées mais **pas encore opérationnelles**

À connaître avant de reprendre — ce sont des espaces **préparés, sans simulation** :

| Fonctionnalité | État réel | Référence |
| --- | --- | --- |
| Générations vidéo MuAPI | Catalogue et suivi présents ; **génération payante bloquée** (plafond 0 USD, tarification désactivée, clé MuAPI non validée) | README §1 |
| Video → Video | Espace préparé, aucun modèle intégré | `src/studio/sections.ts` l. 60 |
| Avatar parlant / Lip Sync | Espace préparé, création audio non disponible | `sections.ts` l. 55 |
| Image Studio, Audio Studio, AI Clipping, Body Swap, Cinema/Marketing Studio, Workflows, Agents, Storyboarding | Routes et architecture en place, **aucun fournisseur, aucun bouton de génération** | `src/studio/sections.ts` |
| Adaptateurs fournisseurs autres que Groq/Gemini | `PROVIDER_ADAPTER_NOT_IMPLEMENTED` — 8 fournisseurs `unverified` (anthropic, deepseek, gonka, kilo, llm7, mistral, openai, openrouter) | `handler.ts` l. 344 |
| Test de génération IA de bout en bout | **Jamais rejoué volontairement** (aucun crédit consommé) ; validé par l'historique `ai_requests` | `docs/incident-business-grow-prod-20261112.md` §5 |
| Préflight CORS `OPTIONS` | Non simulable depuis `pg_net` (domaine `http_method`) — preuve indirecte seulement | idem |

---

## 4. Correspondance avec la production

Le code de la branche **ne décrit pas exactement** ce qui tourne en production : certaines
choses ont été appliquées directement côté serveur.

| Ressource | Production | Code dans le dépôt |
| --- | --- | --- |
| Edge `business-grow` | **v13 ACTIVE**, `verify_jwt: true` | Branche = même code + correctif CORS |
| Edge `vyora-ai` | **v3** | `supabase/functions/vyora-ai/` |
| Edge `vyora-provider-health` | **v1** | `supabase/functions/vyora-provider-health/` |
| Edge `reelora-ai` / `reelora-health` | v9 / v10 | fichiers présents |
| Edge `video-quote` | v4 | fichier présent |
| Jobs cron | **11** (daily) et **12** (fresh-guard) | La migration indique `cron.schedule` par nom, donc les identifiants définitifs sont ceux de la base |
| Migration `20261112001000` | **appliquée** | présente dans la branche |

**Point d'attention honnête :** le tableau « Edge Functions déployées (live) » du README
(§3, l. 134-140) indique encore des versions anciennes (`business-grow` v6, `reelora-ai` v6,
`reelora-video` v10…). C'est **obsolète** par rapport à la production (business-grow v13).
Je peux le corriger dans un commit dédié si vous le souhaitez.

---

## 5. Commandes utiles depuis VS Code (Windows / PowerShell)

```powershell
git clone https://github.com/ibrahimdiango514/SaaS-UGC.git
cd SaaS-UGC
git checkout arena/323bad30-saas-ugc
npm ci
npm run dev          # http://localhost:5173 (bind 0.0.0.0)
npm test             # 46 fichiers / 494 tests
npm run typecheck    # tsc -b
npm run build        # tsc -b && vite build
npm run check:edge-imports
```

Variables d'environnement : copier `.env.example` vers `.env.local` (voir README §4).
Les secrets serveur (clés Groq/Gemini/MuAPI, jeton Vault) **ne sont pas dans le dépôt** —
ils restent dans Supabase. Ne les mettez jamais dans `.env.local` côté client.

---

## 6. Synthèse en une phrase

Tout le travail récent est sur **`arena/323bad30-saas-ugc` (`f78fb81`)**, `main` (`1a572be`)
s'arrête à la PR #5, et la PR #6 reste ouverte : travailler sur la branche, jamais sur `main`,
tant que la fusion n'est pas décidée.

### Capacités média (commit `20b1533`)

Video→Video et Lip Sync sont câblés de bout en bout dans le code : import de la
vidéo/audio source, signature côté passerelle, transmission au devis puis au corps
MuAPI uniquement si le modèle déclare le champ. Deep link `?mode=video-source` /
`?mode=audio-source`. **Le runtime déployé n'a pas été mis à jour** : `reelora-video`
en production est encore la v10, donc ces deux capacités sont inactives en prod
tant que la fonction n'est pas redéployée.

### Abonnement Business Grow (commit `20b1533`)

`saas_business.plans` enrichi (prix, devise, quota, avantages, ordre) et
`saas_business.commercial_config` créée — **périmètre `saas_business` uniquement**.
Trois formules (Essentiel, Croissance, Scale) existent avec `active = false` et
`monthly_price_minor = NULL` : aucun prix inventé n'est exposé. Page
`/app/business/abonnement`, alimentée par `public.business_grow_catalog()`.
Aucune table de crédits Studio n'est lue ni modifiée par cette page.
