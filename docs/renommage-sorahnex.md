# Renommage VYORA / REELORA → SORAHNEX

Date : 2026-11-25. Base : `ec8d46d` (production vérifiée). Auteur : agent Freebuff.

## 1. Point de restauration

| Élément | Valeur |
| --- | --- |
| Commit de production avant intervention | `ec8d46d` — `origin/main`, arbre local identique (`git diff FETCH_HEAD HEAD` vide) |
| Retour arrière code | `git revert <commit de fusion>` sur `main`, ou redéploiement de `ec8d46d` |
| Retour arrière base | SQL fourni en fin de document (restaure `platform.name = 'VYORA'`) |
| Données clients | Aucune ligne client, aucun solde, aucun abonnement, aucune ressource de stockage n'a été modifié |

Le renommage ne touche aucune table métier : seuls les libellés de configuration
`ugc_app_settings` (clé `platform`) et leurs descriptions ont changé.

## 2. Inventaire initial

655 fichiers contenaient `VYORA` ou `REELORA` (~4 550 occurrences). La répartition
a dicté la méthode : un remplacement global aurait cassé la production.

| Catégorie | Exemples | Volume | Décision |
| --- | --- | --- | --- |
| Textes visibles (UI, docs, SEO) | `SORAHNEX`, `SORAHNEX Studio` | ~1 900 | **Migré** |
| Variables d'environnement | `VYORA_BUILD_ENABLED`, `VYORA_ALLOWED_ORIGINS`, `VYORA_SASPAY_*` | 130 | **Conservé** — une variable renommée sans redéploiement simultané désactive le service |
| Edge Functions | `vyora-ai`, `vyora-mcp`, `reelora-video`, `reelora-health` | 570 | **Conservé** — URL publiques, chargeurs épinglés, secrets liés |
| Fonctions SQL / RPC | `vyora_admin_*`, `reelora_start_generation` | ~1 700 | **Conservé** — 102 RPC `bg_*` + RPC historiques, grants et RLS associés |
| Tables, buckets, sites | `vyora_files`, bucket `ugc-assets`, site Netlify `vyora-saas-ugc` | 120 | **Conservé** — données et déploiements en production |
| Classes CSS / animations | `vyora-card`, `vyora-reveal-in` | ~200 | **Conservé** — identifiants de style internes, jamais visibles |
| Artefacts Edge épinglés | `_artifacts/*.js`, `*.edge.js` | 360 | **Conservé** — épinglés par commit + SHA-256 (voir §5) |
| Code de marque réel | composants, marqueur, titres | ~260 | **Migré** |

## 3. Ce qui a été migré (286 fichiers)

- **Identité visuelle** : `Brand.tsx` et `public/sorahnex-mark.svg` — nouveau
  monogramme « S » (l'ancien traçait un « V »), `index.html` (titre, description,
  `og:*`, `application-name`, favicon, apple-touch-icon).
- **Architecture de marque** : `SORAHNEX`, `SORAHNEX Studio`, `SORAHNEX Grow`.
  Le module historique « Business Grow » garde son nom fonctionnel dans le code
  (`business-grow`, routes `/app/business/*`) : le vocabulaire produit de
  l'utilisateur, et 200+ tests, s'appuient dessus.
- **Interfaces** : landing, connexion/inscription, tableau de bord, Studio,
  Business Grow, assistant, admin, paramètres, pages légales.
- **Documentation** : README + 54 documents de `docs/`.
- **Métadonnées** : `package.json` (`name: sorahnex`, description), netlify
  (commentaires), workflows GitHub.
- **Ressources renommées** (sûres, références mises à jour) :
  `public/vyora-mark.svg` → `public/sorahnex-mark.svg`,
  `public/brand/vyora-{hero,growth,cta}.jpg` → `public/brand/sorahnex-{hero,growth,cta}.jpg`.
- **Base de données** : `ugc_app_settings.platform.name` → `SORAHNEX`
  (migration `20261125120000_sorahnex_platform_identity.sql`, appliquée et
  vérifiée). `support_email` reste `support@vyora.app` : la boîte existe et
  reçoit le courrier ; la basculer vers un domaine non prouvé casserait le
  support.
- **Code promo** : `REELORA2026` reste valide en base ; seul le *placeholder* du
  champ est devenu « Code promo » pour ne pas suggérer un code inexistant.

L'outil de migration est versionné : `scripts/rename-brand.mjs`
(`--check` liste les occurrences restantes).

## 4. Ce qui reste volontairement en VYORA / REELORA

| Zone | Occurrences | Pourquoi | Comment finir |
| --- | --- | --- | --- |
| `supabase/functions/**` (sources) | 363 | Messages d'erreur des Edge Functions déployées. Leur code est embarqué dans des bundles épinglés par SHA-256 ; renommer la source sans régénérer casse l'empreinte → `503 BUSINESS_GROW_ARTIFACT_UNAVAILABLE` (incident déjà vécu le 2026-11-24) | Cycle de réépinglage (§5) |
| 19 modules `src/` inlinés dans ces bundles (`src/business/importer/*`, `src/lib/origin-allowlist.ts`) | 31 | Ces fichiers sont *compilés dans* les artefacts Edge : leur texte fait partie des octets épinglés | Même cycle |
| Tests de parité des artefacts | 22 | Ils comparent le bundle généré aux octets épinglés : ils doivent rester alignés sur la production | Même cycle |
| Variables `VYORA_*`, slugs `vyora-*`, RPC `vyora_*` / `reelora_*`, site Netlify, dépôt GitHub | — | Ressources techniques immuables sans plan de migration | Renommage séparé, avec double écriture et redéploiement |
| Dépôt GitHub `ibrahimdiango514/SaaS-UGC` | — | Les chargeurs Edge téléchargent les artefacts depuis `raw.githubusercontent.com/.../SaaS-UGC/<commit>`. Renommer le dépôt casse ce chemin et les déploiements | À faire **après** le cycle §5, en réécrivant `GITHUB_REPO` dans les générateurs |
| Site Netlify `vyora-saas-ugc` | — | Nom vérifié par la garde de build à quatre conditions (`netlify.toml`) et par les tests | Renommer le site puis les deux gardes, en une PR dédiée |

## 5. Procédure du cycle de réépinglage (à exécuter en PR séparée)

```bash
# 1. Renommer la marque dans les sources Edge et les modules inlinés
#    (retirer les exclusions correspondantes de scripts/rename-brand.mjs)
# 2. Régénérer bundles + artefacts
node scripts/build-edge-bundle.mjs
node scripts/build-edge-artifact.mjs store-import
node scripts/build-edge-artifact.mjs store-connect
# 3. Commiter les artefacts, fusionner, puis réépingler sur le commit de main
EDGE_PIN_COMMIT=<sha de main contenant les artefacts> node scripts/build-edge-artifact.mjs store-import
# 4. Redéployer les Edge Functions ; vérifier 401 (et non 503) sur chacune
```

Tant que ce cycle n'est pas fait, les messages d'erreur renvoyés par les Edge
Functions affichent encore l'ancienne marque. **Aucune fonctionnalité n'est
dégradée** par cet état : c'est un écart de libellé, pas de comportement.

## 6. Vérifications exécutées

| Contrôle | Résultat |
| --- | --- |
| `npm run typecheck` (`tsc -b`) | 0 erreur |
| `npx vitest run` | 3 300 tests, 208 fichiers — **vert** |
| `npm run build` | OK (bundle de production généré) |
| `node scripts/rename-brand.mjs --check` | 0 occurrence hors zones techniques |
| Lecture base `ugc_app_settings` | `platform.name = SORAHNEX` confirmé |

## 7. Retour arrière base de données

```sql
update public.ugc_app_settings
set setting_value = jsonb_set(setting_value, '{name}', to_jsonb('VYORA'::text), true),
    updated_at = now()
where setting_key = 'platform';
update public.ugc_app_settings
set description = replace(description, 'SORAHNEX', 'VYORA')
where description like '%SORAHNEX%';
```
